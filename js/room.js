import { db, ensureSignedIn, auth, WORKER_BASE_URL } from "./firebase-config.js";
import { doc, getDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { isAdmin, promptAdminLogin, getAdminPassword } from "./admin.js";
import { callApi } from "./api.js";
import { Chess } from "https://esm.sh/chess.js@1.4.0";
import { uciToCoords, getPositionEval } from "./ai-engine.js";

/* =========================================================
   기본 세팅
   - 판/규칙/승패는 전부 서버(xeon-worker)가 검증한 room 문서(fen, moves, status...)를
     그대로 반영만 함. 클라이언트는 화면 표시와, 서버 API 호출만 담당.
========================================================= */
const params = new URLSearchParams(window.location.search);
const roomId = params.get("room");

const PIECES = {
  'r': '♜', 'n': '♞', 'b': '♝', 'q': '♛', 'k': '♚', 'p': '♟',
  'R': '♖', 'N': '♘', 'B': '♗', 'Q': '♕', 'K': '♔', 'P': '♙'
};
const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

function squareName(r, c) { return FILES[c] + (8 - r); }
function squareToRC(sq) { return { r: 8 - parseInt(sq[1], 10), c: FILES.indexOf(sq[0]) }; }

function toBoardGrid(chess) {
  // chess.board(): grid[0] = 8랭크(위쪽) ... grid[7] = 1랭크(아래쪽), 기존 boardState와 동일한 방향
  return chess.board().map(row =>
    row.map(sq => sq ? (sq.color === "w" ? sq.type.toUpperCase() : sq.type.toLowerCase()) : "")
  );
}

// moves(lan 문자열 배열, 예: "e2e4", "e7e8q")를 순서대로 재생해서
// 각 시점의 보드 상태 / SAN 로그 / 마지막 수를 미리 계산해둠 (이전/다음 버튼 열람용)
function buildHistory(movesArr) {
  const chess = new Chess();
  const boards = [toBoardGrid(chess)];
  const sans = [];
  const lastMoves = [null];
  const fens = [chess.fen()];
  for (const lan of movesArr || []) {
    const from = lan.slice(0, 2);
    const to = lan.slice(2, 4);
    const promotion = lan.slice(4) || undefined;
    let mv = null;
    try { mv = chess.move({ from, to, promotion }); } catch (e) { mv = null; }
    sans.push(mv ? mv.san : "?");
    boards.push(toBoardGrid(chess));
    lastMoves.push({ from, to });
    fens.push(chess.fen());
  }
  return { boards, sans, lastMoves, fens };
}

let currentUser = null;
let roomRef = null;
let room = null;
let history = { boards: [toBoardGrid(new Chess())], sans: [], lastMoves: [null], fens: [new Chess().fen()] };
let myRole = null;
let myColor = null;

// 닉네임(users/{uid})과 승/패/무 전적(playerStats/{uid}) — 방장은 항상 왼쪽,
// 도전자는 항상 오른쪽에 표시하므로 "나/상대"가 아니라 "방장/도전자" 기준으로 구독함
let hostNickname = null;
let challengerNickname = null;
let hostStats = null;
let challengerStats = null;
let hostUserUnsub = null;
let challengerUserUnsub = null;
let hostStatsUnsub = null;
let challengerStatsUnsub = null;
let subscribedHostId = null;
let subscribedChallengerId = null;

// 수 품질 표시(✅🤫❌❓) — 순전히 내 화면에서만 계산하는 클라이언트 전용 분석
const moveQuality = new Map(); // ply(1부터) -> 이모지
const fenEvalCache = new Map(); // fen -> 백 기준 센티폰 평가(또는 null)
let qualityComputeChain = Promise.resolve();
let lastKnownTotalForQuality = 0;

// 준비 버튼: 서버 응답 기다리지 않고 누르자마자 체크 표시를 보여주기 위한 낙관적 상태.
// 다음 실제 onSnapshot이 도착하면(성공/실패/재대국 리셋 등 어떤 경우든) 곧바로 초기화됨.
let optimisticReady = false;

let viewIndex = 0;
let followLatest = true;
let roomGoneHandled = false;
let lastKnownMovesLen = 0;

// 관전자용 판 반전 (로컬 상태, 서버에는 저장하지 않음)
let spectatorFlip = false;

// 무르기 UI용 동적 DOM 요소 (room.html에 별도 마크업이 없어도 동작하도록 스크립트에서 생성)
let flipBtn = null;
let undoBtn = null;
let undoStatusEl = null;
let undoCountdownEl = null;
let undoTimerHandle = null;
let undoTimerRequestKey = null;

// 결과 화면(오버레이) 상태
let resultOverlayEl = null;
let resultShownKey = null;
let resultDismissed = false;

/* =========================================================
   DOM 참조
========================================================= */
const waitingPhase = document.getElementById("waitingPhase");
const gamePhase = document.getElementById("gamePhase");
const roomTitleEl = document.getElementById("roomTitle");
const roomRuleSummaryEl = document.getElementById("roomRuleSummary");
const readyBtn = document.getElementById("readyBtn");
const leaveWaitingBtn = document.getElementById("leaveWaitingBtn");
const waitingStatusEl = document.getElementById("waitingStatus");

// 대기 화면: 왼쪽=방장, 오른쪽=도전자, 가운데=준비 버튼
const waitingHostNameEl = document.getElementById("waitingHostName");
const waitingHostCheckEl = document.getElementById("waitingHostCheck");
const waitingChallengerNameEl = document.getElementById("waitingChallengerName");
const waitingChallengerCheckEl = document.getElementById("waitingChallengerCheck");

const boardEl = document.getElementById("board");
// 게임 화면: 왼쪽=방장, 오른쪽=도전자 (보는 사람과 무관하게 항상 같은 배치)
const hostNameEl = document.getElementById("hostName");
const hostTimeEl = document.getElementById("hostTime");
const challengerNameEl = document.getElementById("challengerName");
const challengerTimeEl = document.getElementById("challengerTime");
const statusEl = document.getElementById("gameStatus");

const resignBtn = document.getElementById("resignBtn");
const adminDeleteBtn = document.getElementById("adminDeleteBtn");
const adminCornerEl = document.getElementById("adminCorner");

const logPanelEl = document.getElementById("logPanel");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const latestBtn = document.getElementById("latestBtn");

init();

async function init() {
  if (!roomId) {
    document.body.innerHTML = "<p style='color:#fff;padding:24px;'>잘못된 접근이에요. 방 정보가 없어요.</p>";
    return;
  }
  currentUser = await ensureSignedIn();
  callApi("/api/ensure-user", {}).catch((e) => console.error("[프로필 초기화 실패]", e));
  roomRef = doc(db, "rooms", roomId);

  const snap = await getDoc(roomRef);
  if (!snap.exists()) {
    document.body.innerHTML = "<p style='color:#fff;padding:24px;'>존재하지 않는 방이에요.</p>";
    return;
  }

  await joinAsRole(snap.data());
  if (myRole === "host" || myRole === "challenger") {
    localStorage.setItem("xeon_last_room", roomId);
  }
  buildExtraUI();
  bindUI();
  startHeartbeat();
  startDisconnectWatcher();
  startIdleWatcher();
  updateAdminUI();

  onSnapshot(roomRef, (docSnap) => {
    if (!docSnap.exists()) {
      if (roomGoneHandled) return;
      roomGoneHandled = true;
      localStorage.removeItem("xeon_last_room");
      alert("삭제된 방입니다");
      window.location.href = "index.html";
      return;
    }
    room = docSnap.data();
    optimisticReady = false; // 실제 상태가 왔으니 낙관적 추측은 더 이상 필요 없음
    const newTotal = (room.moves || []).length;
    if (newTotal < lastKnownTotalForQuality) {
      // 무르기나 재대국으로 수가 줄어들면, 그 이후 인덱스에 계산해둔 품질 표시는 더 이상 유효하지 않음
      for (const key of Array.from(moveQuality.keys())) {
        if (key > newTotal) moveQuality.delete(key);
      }
    }
    lastKnownTotalForQuality = newTotal;
    history = buildHistory(room.moves);
    scheduleQualityAnalysis(newTotal);
    render();
  });
}

/* =========================================================
   추가 UI 생성 (판 뒤집기 / 무르기 요청 & 확인 / 결과 화면)
   room.html에 해당 마크업이 없어도 동작하도록 여기서 직접 DOM을 만들어 붙임
========================================================= */
function buildExtraUI() {
  if (!document.getElementById("xeon-extra-style")) {
    const style = document.createElement("style");
    style.id = "xeon-extra-style";
    style.textContent = `
      .xeon-controls { display:flex; gap:8px; align-items:stretch; margin-top:10px; flex-wrap:wrap; order:5; }
      .xeon-btn { padding:6px 14px; border-radius:6px; border:1px solid #666; background:#2b2b2b; color:#fff; cursor:pointer; font-size:14px; box-sizing:border-box; }
      .xeon-btn:hover:not(:disabled) { background:#3a3a3a; }
      .xeon-btn:disabled { opacity:.4; cursor:default; }
      .xeon-undo-status { display:flex; align-items:center; font-size:13px; color:#ccc; }
      .xeon-undo-countdown {
        display:none; align-items:center; justify-content:center;
        aspect-ratio: 1 / 1; height:auto; box-sizing:border-box;
        border-radius:4px; background:#3a3a3a; color:#999; font-size:12px; line-height:1;
      }
      .xeon-result-overlay { position:fixed; inset:0; background:rgba(0,0,0,.65); display:flex; align-items:center; justify-content:center; z-index:1000; }
      .xeon-result-box { background:#1e1e1e; color:#fff; padding:28px 32px; border-radius:14px; min-width:260px; text-align:center; box-shadow:0 10px 40px rgba(0,0,0,.5); }
      .xeon-result-box h2 { margin:0 0 8px; font-size:22px; }
      .xeon-result-box p { margin:0 0 20px; color:#ccc; font-size:14px; }
      .xeon-result-box .xeon-btn { margin:4px; }
    `;
    document.head.appendChild(style);
  }

  const controls = document.createElement("div");
  controls.className = "xeon-controls";

  flipBtn = document.createElement("button");
  flipBtn.type = "button";
  flipBtn.className = "xeon-btn";
  flipBtn.textContent = "판 뒤집기";
  flipBtn.style.display = "none";
  flipBtn.addEventListener("click", () => {
    spectatorFlip = !spectatorFlip;
    renderBoardAndLog();
  });

  undoBtn = document.createElement("button");
  undoBtn.type = "button";
  undoBtn.className = "xeon-btn";
  undoBtn.textContent = "무르기 요청";
  undoBtn.style.display = "none";
  // 클릭 동작(요청 보내기 / 수락)은 renderUndoUI에서 상황에 맞게 onclick으로 지정함

  undoCountdownEl = document.createElement("span");
  undoCountdownEl.className = "xeon-undo-countdown";

  undoStatusEl = document.createElement("span");
  undoStatusEl.className = "xeon-undo-status";

  controls.appendChild(flipBtn);
  controls.appendChild(undoBtn);
  controls.appendChild(undoCountdownEl);
  controls.appendChild(undoStatusEl);

  // 가로모드에서 그리드의 "opt" 자리(무르기/최신수 토글)에 들어가려면
  // .game-layout의 그리드 아이템이어야 하므로 그 안에 넣음
  const gameLayoutEl = document.querySelector(".game-layout");
  (gameLayoutEl || gamePhase).appendChild(controls);

  buildPromotionUi();
}

/* =========================================================
   폰 승진(프로모션) 기물 선택 모달
   - 퀸/룩/비숍/나이트를 가로로 나열해서 탭으로 고르게 함
   - AI 힌트가 켜져 있고, 그 자리에서 AI가 추천한 승진 기물이 있으면
     그 선택지에 파란 테두리(.ai-suggest-piece)를 표시함
========================================================= */
let promoOverlayEl = null;
let promoTitleEl = null;
let promoChoicesEl = null;
let promoResolve = null;

function buildPromotionUi() {
  if (document.getElementById("xeonPromoOverlay")) return;

  promoOverlayEl = document.createElement("div");
  promoOverlayEl.id = "xeonPromoOverlay";
  promoOverlayEl.className = "promo-overlay";
  promoOverlayEl.style.display = "none";

  const box = document.createElement("div");
  box.className = "promo-box";

  promoTitleEl = document.createElement("p");
  promoTitleEl.className = "promo-title";
  promoTitleEl.textContent = "승진할 기물을 선택하세요";

  promoChoicesEl = document.createElement("div");
  promoChoicesEl.className = "promo-choices";

  box.appendChild(promoTitleEl);
  box.appendChild(promoChoicesEl);
  promoOverlayEl.appendChild(box);

  // 오버레이 바깥(뒷배경) 클릭 시 취소
  promoOverlayEl.addEventListener("click", (e) => {
    if (e.target === promoOverlayEl) closePromotionModal(null);
  });

  document.body.appendChild(promoOverlayEl);
}

// color: "w" | "b" (승진하는 쪽), aiPickLetter: "q"|"r"|"b"|"n" | null (AI 추천 기물)
function askPromotionChoice(color, aiPickLetter) {
  buildPromotionUi();
  promoChoicesEl.innerHTML = "";

  const order = ["q", "r", "b", "n"];
  for (const letter of order) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "promo-piece-btn";
    const pieceChar = color === "w" ? letter.toUpperCase() : letter;
    btn.textContent = PIECES[pieceChar] || pieceChar;
    if (aiPickLetter && aiPickLetter.toLowerCase() === letter) {
      btn.classList.add("ai-suggest-piece");
    }
    btn.addEventListener("click", () => closePromotionModal(letter));
    promoChoicesEl.appendChild(btn);
  }

  promoOverlayEl.style.display = "flex";

  return new Promise((resolve) => {
    promoResolve = resolve;
  });
}

function closePromotionModal(letterOrNull) {
  if (promoOverlayEl) promoOverlayEl.style.display = "none";
  const resolve = promoResolve;
  promoResolve = null;
  if (resolve) resolve(letterOrNull);
}

/* =========================================================
   역할 배정 (도전자 슬롯 선점은 서버 /api/join이 경쟁 상황까지 안전하게 처리)
========================================================= */
async function joinAsRole(initialData) {
  if (initialData.hostId === currentUser.uid) { myRole = "host"; return; }
  if (initialData.challengerId === currentUser.uid) { myRole = "challenger"; return; }

  // 비밀번호 방인데 로비를 거치지 않고 URL로 바로 들어온 경우(비밀번호를 아예 안 가지고 있음) —
  // 서버에 굳이 물어보지 않고 바로 돌려보냄. 관전자로도 들여보내지 않음(비번의 의미가 없어지므로).
  const sessionKey = `xeon_join_pw_${roomId}`;
  const storedPassword = sessionStorage.getItem(sessionKey);
  sessionStorage.removeItem(sessionKey); // 한 번 쓰고 버림(세션에 오래 남겨두지 않음)

  if (initialData.hasPassword && storedPassword === null) {
    alert("비밀번호가 필요한 방이에요. 로비에서 다시 입장해주세요.");
    window.location.href = "index.html";
    return;
  }

  if (!initialData.challengerId) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await callApi("/api/join", { roomId, password: storedPassword || "" });
        myRole = res.role;
        return;
      } catch (e) {
        console.error("[join 실패]", e);
        if (e.message && e.message.indexOf("비밀번호") !== -1) {
          // 비밀번호가 틀린 경우엔 재시도할 필요가 없고, 관전자로도 들여보내지 않음
          alert("비밀번호가 틀렸어요.");
          window.location.href = "index.html";
          return;
        }
        if (attempt === 1) {
          // 원인(인증 실패 / CORS / 네트워크)을 바로 알 수 있도록 조용히 넘어가지 않고 알려줌
          alert("입장 처리에 실패해서 일단 관전자로 들어가요.\n" + e.message);
        }
      }
    }
  }

  // 비밀번호 방에 이미 두 자리가 다 찬 상태로 들어온 관전자는 비밀번호를 알고 있었으니 통과시킴
  myRole = "spectator";
}

/* =========================================================
   접속 상태 — Firestore 하트비트 + 서버 검증 기반 끊김 감지
   (클라이언트가 "상대 끊겼다"고 주장해도, 서버가 하트비트 타임스탬프로 직접 재확인함)
========================================================= */
let hasActivitySinceHeartbeat = true; // 입장 직후는 활동으로 간주(최초 기준시각 설정용)
document.addEventListener("click", () => { hasActivitySinceHeartbeat = true; }, { passive: true });

let lastKnownIdToken = null;

function startHeartbeat() {
  if (myRole !== "host" && myRole !== "challenger") return;
  const send = async () => {
    if (auth.currentUser) {
      try { lastKnownIdToken = await auth.currentUser.getIdToken(); } catch (e) {}
    }
    const active = hasActivitySinceHeartbeat;
    hasActivitySinceHeartbeat = false;
    callApi("/api/heartbeat", { roomId, active }).catch(() => {});
  };
  send();
  setInterval(send, 5000);
}

// 탭을 그냥 닫거나 새로고침/뒤로가기 하는 경우: "나가기" 버튼과 달리 콜백을 기다려줄 수
// 없으니, 브라우저가 보장해주는 sendBeacon으로 /api/leave를 쏴서 최대한 즉시 처리되게 함.
// (100% 보장은 아니지만 일반적인 탭 닫기/새로고침에서는 잘 동작함)
function leaveBeaconOnUnload() {
  if (myRole !== "host" && myRole !== "challenger") return;
  if (!lastKnownIdToken) return;
  const payload = JSON.stringify({ roomId, idToken: lastKnownIdToken });
  navigator.sendBeacon(`${WORKER_BASE_URL}/api/leave`, new Blob([payload], { type: "application/json" }));
}
window.addEventListener("pagehide", leaveBeaconOnUnload);

let idleClaimInFlight = false;
function startIdleWatcher() {
  if (myRole !== "host" && myRole !== "challenger") return;
  setInterval(() => {
    if (!room || idleClaimInFlight || room.status === "finished") return;
    const now = Date.now();
    const isStale = (field, requiredId) => {
      if (!requiredId) return false; // 아직 아무도 안 들어온 자리는 방치로 안 침
      const t = room[field] ? Date.parse(room[field]) : null;
      return !t || now - t > 10 * 60 * 1000; // 10분
    };
    const hostIdle = isStale("hostLastActionAt", room.hostId);
    const challengerIdle = isStale("challengerLastActionAt", room.challengerId);
    if (!hostIdle && !challengerIdle) return;
    idleClaimInFlight = true;
    callApi("/api/claim-idle", { roomId })
      .catch(() => {})
      .finally(() => { idleClaimInFlight = false; });
  }, 15000);
}

let disconnectClaimInFlight = false;
function startDisconnectWatcher() {
  if (myRole !== "host" && myRole !== "challenger") return;
  setInterval(() => {
    if (!room || disconnectClaimInFlight || room.status === "finished") return;
    const oppField = myRole === "host" ? "challengerLastSeenAt" : "hostLastSeenAt";
    const seenAt = room[oppField] ? Date.parse(room[oppField]) : null;
    if (!seenAt) return;
    if (Date.now() - seenAt > 30000) {
      disconnectClaimInFlight = true;
      callApi("/api/claim-disconnect", { roomId })
        .catch(() => {})
        .finally(() => { disconnectClaimInFlight = false; });
    }
  }, 4000);
}

/* =========================================================
   나가기 / 기권
========================================================= */
async function leaveRoom() {
  if (myRole === "spectator") {
    window.location.href = "index.html";
    return;
  }
  localStorage.removeItem("xeon_last_room");
  try {
    await callApi("/api/leave", { roomId });
  } catch (e) {
    console.error(e);
  }
  window.location.href = "index.html";
}

async function handleResignClick() {
  if (!room || room.status !== "playing" || myRole === "spectator") return;
  if (!confirm("정말 기권하시겠어요?")) return;
  try {
    await callApi("/api/resign", { roomId });
  } catch (e) {
    alert(e.message);
  }
}

/* =========================================================
   관리자 모드
========================================================= */
function updateAdminUI() {
  adminDeleteBtn.style.display = isAdmin() ? "inline-block" : "none";
}

async function handleAdminDelete() {
  if (!confirm("이 방을 삭제할까요? (관리자)")) return;
  try {
    await callApi("/api/admin-delete", { roomId, password: getAdminPassword() });
  } catch (e) {
    alert("삭제에 실패했어요: " + e.message);
  }
}

/* =========================================================
   준비 버튼
========================================================= */
function bindUI() {
  readyBtn.addEventListener("click", handleReadyClick);
  prevBtn.addEventListener("click", () => {
    viewIndex = Math.max(0, viewIndex - 1);
    followLatest = viewIndex === (room.moves || []).length;
    renderBoardAndLog();
    recordHistoryAction("prev");
  });
  nextBtn.addEventListener("click", () => {
    const total = (room.moves || []).length;
    viewIndex = Math.min(total, viewIndex + 1);
    followLatest = viewIndex === total;
    renderBoardAndLog();
    recordHistoryAction("next");
  });
  latestBtn.addEventListener("click", () => {
    viewIndex = (room.moves || []).length;
    followLatest = true;
    renderBoardAndLog();
  });

  bindLogSwipe();

  leaveWaitingBtn.addEventListener("click", leaveRoom);
  resignBtn.addEventListener("click", handleResignClick);
  adminDeleteBtn.addEventListener("click", handleAdminDelete);
  adminCornerEl.addEventListener("click", async () => {
    if (await promptAdminLogin()) updateAdminUI();
  });
}

async function handleReadyClick() {
  if (myRole !== "host" && myRole !== "challenger") return;
  readyBtn.disabled = true;
  optimisticReady = true;
  renderWaitingPhase(); // 서버 응답 기다리지 않고 바로 체크 표시
  try {
    await callApi("/api/ready", { roomId, ready: true });
  } catch (e) {
    console.error(e);
    optimisticReady = false;
    readyBtn.disabled = false;
    renderWaitingPhase();
    alert("준비 처리에 실패했어요: " + (e.message || "다시 시도해주세요"));
  }
}

/* =========================================================
   로그 패널 좌우 드래그(스와이프)로 이전/다음 수 이동
   - 세로모드 전용 기능. 세로모드에서는 로그 패널이 얕고 넓은 띠 형태라
     좌우 스와이프가 자연스러움
   - 가로모드에서는 로그 패널이 세로로 긴 직사각형 목록이라 위아래 스크롤이
     기본 동작이어야 하므로, 이 기능은 가로모드일 때 아예 동작하지 않음
     (기존 위아래 스크롤을 그대로 씀)
   - 세로 스크롤(로그 목록 위아래 스크롤)과 겹치지 않도록, 가로 이동량이
     세로 이동량보다 뚜렷하게 클 때만 스와이프로 인식함
   - 스와이프가 인식된 경우, 그 아래 있던 log-btn(수 클릭)의 클릭 이벤트는
     막아서 스와이프 끝에 엉뚱한 수로 튀는 걸 방지함
========================================================= */
function bindLogSwipe() {
  const SWIPE_THRESHOLD = 40; // 이 정도 가로로 움직여야 스와이프로 인정
  const isPortrait = () => window.matchMedia("(orientation: portrait)").matches;
  let startX = null;
  let startY = null;
  let swiping = false;
  let suppressClick = false;

  logPanelEl.addEventListener("pointerdown", (e) => {
    if (!isPortrait()) return; // 가로모드에서는 스와이프 감지 자체를 시작하지 않음 (기존 위아래 스크롤 그대로 둠)
    logPanelEl.style.touchAction = "pan-y";
    startX = e.clientX;
    startY = e.clientY;
    swiping = false;
  });

  logPanelEl.addEventListener("pointermove", (e) => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!swiping && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
      swiping = true;
    }
  });

  logPanelEl.addEventListener("pointerup", (e) => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (swiping && Math.abs(dx) >= SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
      suppressClick = true;
      if (dx < 0) {
        nextBtn.click(); // 왼쪽으로 드래그 -> 다음 수
      } else {
        prevBtn.click(); // 오른쪽으로 드래그 -> 이전 수
      }
    }
    startX = null;
    startY = null;
    swiping = false;
  });

  logPanelEl.addEventListener("pointercancel", () => {
    startX = null;
    startY = null;
    swiping = false;
  });

  // 스와이프 직후 발생하는 click(예: log-btn 클릭)을 한 번만 무시
  logPanelEl.addEventListener(
    "click",
    (e) => {
      if (suppressClick) {
        suppressClick = false;
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true
  );
}

/* =========================================================
   렌더링
========================================================= */
function render() {
  if (!room) return;

  if (myRole === "host") myColor = room.hostColor || null;
  else if (myRole === "challenger") myColor = room.challengerColor || null;
  else myColor = null; // 관전자 — 색이 없으므로 spectatorFlip 토글로만 반전

  if (room.status === "waiting") {
    waitingPhase.style.display = "block";
    gamePhase.style.display = "none";
    renderWaitingPhase();
    return;
  }

  waitingPhase.style.display = "none";
  gamePhase.style.display = "block";

  const total = (room.moves || []).length;
  if (total !== lastKnownMovesLen) {
    // 정상적인 수 진행이든 무르기로 수가 줄어든 경우든, 낡은 선택 상태는 버림
    selectedPos = null;
    possibleMoves = [];
    lastKnownMovesLen = total;
  }
  if (followLatest) viewIndex = total;
  else if (viewIndex > total) viewIndex = total;
  if (viewIndex < 0) viewIndex = 0;

  renderNames();
  renderBoardAndLog();
  renderUndoUI();

  if (room.status === "finished") {
    showResult();
  } else if (resultOverlayEl) {
    dismissResultOverlay();
  }
}

/* =========================================================
   무르기(undo) UI — 요청 버튼 / 대기 중 상태 / 상대 요청 확인 배너
========================================================= */
function clearUndoTimer() {
  if (undoTimerHandle) {
    clearInterval(undoTimerHandle);
    undoTimerHandle = null;
  }
  undoTimerRequestKey = null;
  undoCountdownEl.style.display = "none";
}

// requestedAt 기준 5초 카운트다운을 표시하고, 시간이 다 되면 onExpire를 한 번 호출함
function startUndoTimer(requestedAt, onExpire) {
  if (undoTimerRequestKey === requestedAt && undoTimerHandle) return; // 같은 요청에 대해 이미 동작 중
  clearUndoTimer();
  undoTimerRequestKey = requestedAt;
  const startedMs = Date.parse(requestedAt);

  const tick = () => {
    const remainMs = 5000 - (Date.now() - startedMs);
    if (remainMs <= 0) {
      clearUndoTimer();
      onExpire();
      return;
    }
    undoCountdownEl.style.display = "flex";
    undoCountdownEl.textContent = String(Math.max(1, Math.ceil(remainMs / 1000)));
  };
  tick();
  undoTimerHandle = setInterval(tick, 200);
}

function autoDeclineUndo() {
  callApi("/api/undo-respond", { roomId, accept: false }).catch(() => {});
}

async function acceptUndoNow() {
  undoBtn.disabled = true;
  try {
    await callApi("/api/undo-respond", { roomId, accept: true });
  } catch (e) {
    alert(e.message);
  } finally {
    undoBtn.disabled = false;
  }
}

function renderUndoUI() {
  if (!room) return;
  const isPlayer = myRole === "host" || myRole === "challenger";
  const total = (room.moves || []).length;
  // 기보를 과거로 넘겨서 보고 있는 중(무르기 요청 상황과는 무관) — 이 경우 무르기 버튼 대신
  // "최신 수로 돌아가기" 버튼을 같은 자리에 보여주고, 최신 수로 돌아오면 다시 무르기가 뜸
  const browsingHistory = viewIndex !== total;

  flipBtn.style.display = myRole === "spectator" ? "inline-block" : "none";

  if (room.status !== "playing" || !isPlayer) {
    undoBtn.style.display = "none";
    undoStatusEl.textContent = "";
    latestBtn.style.display = "none";
    clearUndoTimer();
    return;
  }

  const pending = room.undoRequest;

  if (pending && pending.by === myRole) {
    // 내가 요청함 → 상대 응답(또는 5초 시간 초과) 대기, 5초 지나면 스스로 취소
    // (진행 중인 요청은 기보를 보고 있어도 계속 보여줌 — 시간이 걸린 문제라서)
    undoBtn.style.display = "none";
    undoStatusEl.textContent = "무르기 요청을 보냈어요";
    latestBtn.style.display = "none";
    startUndoTimer(pending.requestedAt, autoDeclineUndo);
    return;
  }

  if (pending && pending.by !== myRole) {
    // 상대가 요청함 → 수락 버튼 + 카운트다운. 5초 안에 안 누르면 자동 거절(거절 버튼 없음)
    undoBtn.style.display = "inline-block";
    undoBtn.disabled = false;
    undoBtn.textContent = "수락";
    undoBtn.onclick = acceptUndoNow;
    undoStatusEl.textContent = "상대가 무르기를 요청했어요";
    latestBtn.style.display = "none";
    startUndoTimer(pending.requestedAt, autoDeclineUndo);
    return;
  }

  clearUndoTimer();

  if (browsingHistory) {
    undoBtn.style.display = "none";
    undoStatusEl.textContent = "";
    latestBtn.style.display = "inline-block";
    latestBtn.disabled = false;
    return;
  }

  latestBtn.style.display = "none";
  undoBtn.textContent = "무르기 요청";
  undoBtn.onclick = handleUndoRequestClick;

  // 방금 내가 두고 상대 차례일 때만 요청 가능 (되돌리는 건 항상 그 직전 수)
  const isOpponentTurnNow = !!myColor && room.turn !== myColor;
  if (!isOpponentTurnNow) {
    undoBtn.style.display = "none";
    undoStatusEl.textContent = "";
    return;
  }

  const usedField = myRole === "host" ? "hostUndoUsed" : "challengerUndoUsed";
  const used = room[usedField] || 0;
  const limit = room.undoLimit;
  const remaining = limit === -1 ? null : Math.max(0, limit - used);
  const noMovesYet = (room.moves || []).length === 0;

  const canRequest = !noMovesYet && (limit === -1 || remaining > 0);
  undoBtn.style.display = "inline-block";
  undoBtn.disabled = !canRequest;
  undoStatusEl.textContent = noMovesYet
    ? "아직 되돌릴 수가 없어요"
    : (limit === -1 ? "무르기 무제한" : `무르기 남은 횟수: ${remaining}/${limit}`);
}

async function handleUndoRequestClick() {
  if (!room || room.status !== "playing" || myRole === "spectator") return;
  if (room.undoRequest) return;
  if (!confirm("무르기를 요청할까요? 상대가 5초 안에 수락해야 되돌려져요.")) return;
  undoBtn.disabled = true;
  try {
    await callApi("/api/undo-request", { roomId });
  } catch (e) {
    alert(e.message);
  } finally {
    undoBtn.disabled = false;
  }
}

function renderWaitingPhase() {
  roomTitleEl.textContent = room.name || "";
  const undoLabel = room.undoLimit === -1 ? "무제한" : `${room.undoLimit}회`;
  const firstMoveLabel = { random: "무작위", host: "방장 선", challenger: "도전자 선" }[room.firstMoveRule] || "무작위";
  roomRuleSummaryEl.textContent = `선공: ${firstMoveLabel} · 무르기 ${undoLabel}`;

  ensureProfileSubscriptions();
  waitingHostNameEl.textContent = hostNickname || "방장";
  waitingChallengerNameEl.textContent = room.challengerId ? (challengerNickname || "도전자") : "대기중...";
  waitingHostCheckEl.style.display = (room.hostReady || (myRole === "host" && optimisticReady)) ? "inline" : "none";
  waitingChallengerCheckEl.style.display = (room.challengerReady || (myRole === "challenger" && optimisticReady)) ? "inline" : "none";

  if (myRole === "spectator") {
    waitingStatusEl.textContent = "게임이 시작되기를 기다리는 중이에요 (관전자)";
    readyBtn.style.display = "none";
    return;
  }

  if (myRole === "host" && !room.challengerId) {
    readyBtn.style.display = "none";
    waitingStatusEl.textContent = "도전자를 기다리는 중이에요...";
    return;
  }

  const amReady = (myRole === "host" ? room.hostReady : room.challengerReady) || optimisticReady;
  // 준비를 누르면 버튼이 사라지고, 대신 내 이름 바로 아래 체크 표시가 뜸
  readyBtn.style.display = amReady ? "none" : "inline-block";
  readyBtn.disabled = false;
  waitingStatusEl.textContent = amReady ? "상대의 준비를 기다리는 중이에요..." : "";
}

function renderNames() {
  ensureProfileSubscriptions();
  hostNameEl.textContent = (hostNickname || "방장") + formatStatsLabel(hostStats);
  challengerNameEl.textContent = (challengerNickname || "도전자") + formatStatsLabel(challengerStats);

  const hostIsTurn = room.hostColor === room.turn;
  hostNameEl.classList.toggle("turn-active", hostIsTurn);
  challengerNameEl.classList.toggle("turn-active", !hostIsTurn);

  startTimeTicker();
  updateTimeDisplay();
}

/* =========================================================
   시간 표시 (서버 turnStartedAt 기준, 실제 판정은 /api/claim-timeout에서 서버가 함)
========================================================= */
let tickerStarted = false;
let timeoutClaimInFlight = false;

function startTimeTicker() {
  if (tickerStarted) return;
  tickerStarted = true;
  setInterval(updateTimeDisplay, 250);
}

function formatTime(sec) {
  if (sec === null || sec === undefined) return "∞";
  sec = Math.max(0, Math.ceil(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

function updateTimeDisplay() {
  if (!room || room.status !== "playing") return;
  const presetSeconds = room.timeControl && room.timeControl.presetSeconds;

  let whiteLeft = room.whiteTimeLeft;
  let blackLeft = room.blackTimeLeft;

  if (presetSeconds && room.turnStartedAt) {
    const elapsed = (Date.now() - Date.parse(room.turnStartedAt)) / 1000;
    if (room.turn === "white") whiteLeft = Math.max(0, whiteLeft - elapsed);
    else blackLeft = Math.max(0, blackLeft - elapsed);
  }

  const hostLeft = room.hostColor === "white" ? whiteLeft : blackLeft;
  const challengerLeft = room.hostColor === "white" ? blackLeft : whiteLeft;
  hostTimeEl.textContent = formatTime(hostLeft);
  challengerTimeEl.textContent = formatTime(challengerLeft);

  if (presetSeconds && (whiteLeft <= 0 || blackLeft <= 0)) {
    claimTimeout();
  }
}

async function claimTimeout() {
  if (timeoutClaimInFlight || myRole === "spectator") return;
  timeoutClaimInFlight = true;
  try {
    await callApi("/api/claim-timeout", { roomId });
  } catch (e) {
    // 아직 서버 기준으로 시간이 안 됐거나(409) 이미 끝난 게임이면 조용히 무시
  } finally {
    timeoutClaimInFlight = false;
  }
}

/* =========================================================
   AI(Stockfish) 힌트 모드
   - 비밀 코드, on/off 상태, 실제 엔진 계산까지 전부 서버(worker)가 처리함.
     클라이언트는 버튼을 누를 때마다 /api/hint-action으로 액션만 전달하고,
     서버가 돌려주는 on/off 결과만 반영함 — room.js 소스를 읽어도 코드나
     현재 켜짐 여부는 알 수 없음.
   - 켜져 있고 내 차례일 때 /api/hint-move를 호출해 추천수를 받아옴.
========================================================= */
let aiHintEnabled = false;
let aiSuggestion = null;       // { from:{r,c}, to:{r,c} } | null
let aiSuggestionForFen = null; // 마지막으로 계산한 fen (턴이 바뀌면 다시 계산하기 위함)
let aiComputing = false;
let aiActionPending = false;

async function recordHistoryAction(action) {
  if (aiActionPending) return;
  aiActionPending = true;
  try {
    const res = await callApi("/api/hint-action", { roomId, action });
    if (res.enabled !== aiHintEnabled) {
      aiHintEnabled = !!res.enabled;
      aiSuggestion = null;
      aiSuggestionForFen = null;
      renderBoardAndLog();
    }
  } catch (e) {
    // 조용히 무시 — 일반적인 이전/다음 버튼 동작에는 영향 없음
  } finally {
    aiActionPending = false;
  }
}

async function updateAiSuggestionIfNeeded(isMyTurnNow) {
  if (!aiHintEnabled || !isMyTurnNow || !room || aiComputing) return;
  if (aiSuggestionForFen === room.fen) return; // 이미 이 상태에서 계산해둠
  aiComputing = true;
  const fenAtRequest = room.fen;
  try {
    const res = await callApi("/api/hint-move", { roomId });
    if (res.moveStr) {
      // UCI 문자열(예: "e7e8q")의 5번째 글자가 있으면 AI가 추천하는 승진 기물
      aiSuggestion = { ...uciToCoords(res.moveStr), promotion: res.moveStr.length > 4 ? res.moveStr[4].toLowerCase() : null };
    } else {
      aiSuggestion = null;
    }
    aiSuggestionForFen = fenAtRequest;
  } catch (e) {
    console.error("[AI 힌트 계산 실패]", e);
  } finally {
    aiComputing = false;
    if (room && room.fen === fenAtRequest) renderBoardAndLog();
  }
}


/* =========================================================
   수 품질 표시 (✅🤫❌❓)
   - chess.com류 UI를 흉내낸 "간단한" 자체 기준일 뿐, 공식 알고리즘과는 다름
     (희생수/유일수 판정 등은 하지 않고, 스톡피시 얕은 평가값의 손실폭만 봄)
   - 각 수 앞뒤 포지션(fen)을 스톡피시로 짧게(300ms) 평가해서, 그 수를 둔 쪽 기준으로
     평가가 얼마나 나빠졌는지(손실, centipawn)를 계산해 4단계로 분류함
   - 연속된 수의 "이후 포지션"과 "다음 수의 이전 포지션"은 같은 fen이라 캐시로 재사용
========================================================= */
function classifyMoveLoss(lossCp) {
  const loss = Math.max(0, lossCp);
  if (loss < 20) return "🤫";   // 아주 좋은 수 (국대급)
  if (loss < 60) return "✅";   // 좋은 수
  if (loss < 150) return "❓";  // 애매한 수
  return "❌";                  // 안좋은 수
}

const fenEvalInflight = new Map(); // fen -> 진행 중인 평가 Promise (같은 포지션 중복 요청 방지)

async function cachedEval(fen) {
  if (fenEvalCache.has(fen)) return fenEvalCache.get(fen);
  if (fenEvalInflight.has(fen)) return fenEvalInflight.get(fen);
  const p = (async () => {
    let val = null;
    try {
      val = await getPositionEval(fen, 300);
    } catch (e) {
      val = null;
    }
    fenEvalCache.set(fen, val);
    fenEvalInflight.delete(fen);
    return val;
  })();
  fenEvalInflight.set(fen, p);
  return p;
}

/* 예전에는 수(ply) 하나마다 evalBefore/evalAfter를 순서대로 기다렸어서
   (기보 다시보기할 때) 한 수 판단하는 데 최대 3초 가까이 걸렸음.
   이제는 필요한 포지션들을 몇 개씩 동시에 평가 요청해서 훨씬 빨리 끝남.
   같은 포지션(예: N수의 "이후"와 N+1수의 "이전"은 같은 fen)은 cachedEval의
   캐시 + 진행 중 요청 재사용으로 중복 호출되지 않음 */
function scheduleQualityAnalysis(total) {
  qualityComputeChain = qualityComputeChain.then(async () => {
    const pending = [];
    for (let i = 1; i <= total; i++) {
      if (moveQuality.has(i)) continue;
      const fenBefore = history.fens[i - 1];
      const fenAfter = history.fens[i];
      if (!fenBefore || !fenAfter) continue;
      pending.push({ i, fenBefore, fenAfter });
    }
    if (pending.length === 0) return;

    const CONCURRENCY = 4; // 서버 부하를 고려해 한 번에 최대 4개 포지션까지 동시 평가
    let cursor = 0;
    async function worker() {
      while (cursor < pending.length) {
        const { i, fenBefore, fenAfter } = pending[cursor++];
        try {
          const [evalBefore, evalAfter] = await Promise.all([
            cachedEval(fenBefore),
            cachedEval(fenAfter),
          ]);
          if (evalBefore === null || evalAfter === null) continue;
          const moverIsWhite = i % 2 === 1; // 1수, 3수... = 백
          const loss = moverIsWhite ? (evalBefore - evalAfter) : (evalAfter - evalBefore);
          moveQuality.set(i, classifyMoveLoss(loss));
          renderLog((room.moves || []).length);
        } catch (e) {
          // 엔진 실패는 표시만 안 뜰 뿐 게임 진행엔 영향 없으니 조용히 넘어감
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
  });
}


/* =========================================================
   닉네임(users/{uid}) + 전적(playerStats/{uid}) 구독
   - 방장/도전자는 항상 왼쪽/오른쪽에 고정 표시되므로, "나/상대"가 아니라
     room.hostId / room.challengerId 기준으로 구독함(관전자 화면에서도 동일하게 보이도록)
========================================================= */
function ensureProfileSubscriptions() {
  if (!room) return;

  if (room.hostId && room.hostId !== subscribedHostId) {
    subscribedHostId = room.hostId;
    if (hostUserUnsub) hostUserUnsub();
    if (hostStatsUnsub) hostStatsUnsub();
    hostUserUnsub = onSnapshot(doc(db, "users", room.hostId), (snap) => {
      hostNickname = snap.exists() ? snap.data().nickname : null;
      renderNames();
    });
    hostStatsUnsub = onSnapshot(doc(db, "playerStats", room.hostId), (snap) => {
      hostStats = snap.exists() ? snap.data() : { wins: 0, losses: 0, draws: 0 };
      renderNames();
    });
  }

  if (room.challengerId && room.challengerId !== subscribedChallengerId) {
    subscribedChallengerId = room.challengerId;
    if (challengerUserUnsub) challengerUserUnsub();
    if (challengerStatsUnsub) challengerStatsUnsub();
    challengerUserUnsub = onSnapshot(doc(db, "users", room.challengerId), (snap) => {
      challengerNickname = snap.exists() ? snap.data().nickname : null;
      renderNames();
    });
    challengerStatsUnsub = onSnapshot(doc(db, "playerStats", room.challengerId), (snap) => {
      challengerStats = snap.exists() ? snap.data() : { wins: 0, losses: 0, draws: 0 };
      renderNames();
    });
  }
}

function formatStatsLabel(stats) {
  if (!stats) return "";
  const wins = stats.wins || 0, losses = stats.losses || 0, draws = stats.draws || 0;
  const total = wins + losses + draws;
  const rate = total > 0 ? Math.round((wins / total) * 100) : 0;
  return ` (${wins}승 ${losses}패 ${rate}%)`;
}

function renderBoardAndLog() {
  const total = (room.moves || []).length;
  const boardGrid = history.boards[viewIndex] ?? history.boards[history.boards.length - 1];
  const lastMove = history.lastMoves[viewIndex] ?? null;
  const isLatest = viewIndex === total;
  const isMyTurnNow = isLatest && myColor && room.turn === myColor && room.status === "playing";

  drawBoard(boardGrid, lastMove, isMyTurnNow);
  renderLog(total);
  updateAiSuggestionIfNeeded(isMyTurnNow);

  // 실제 disabled 속성을 쓰면 클릭 자체가 안 먹혀서(브라우저 기본 동작) 비밀 코드 감지가 안 됨.
  // 그래서 진짜로 비활성화하지 않고, 눌리지 않는 것처럼 "보이기만" 하도록 클래스만 토글함.
  prevBtn.classList.toggle("look-disabled", viewIndex === 0);
  nextBtn.classList.toggle("look-disabled", viewIndex === total);
  latestBtn.disabled = isLatest;

  // prev/next/최신수/기보 클릭 등 render() 전체를 거치지 않는 경로에서도
  // "기보 보는 중 ↔ 최신 수" 상태에 따라 무르기/최신수 버튼이 즉시 갱신되도록 함
  renderUndoUI();
}

function drawBoard(boardGrid, lastMove, isMyTurnNow) {
  boardEl.innerHTML = "";
  const flip = myColor === "black" || (myColor === null && spectatorFlip);

  for (let displayR = 0; displayR < 8; displayR++) {
    for (let displayC = 0; displayC < 8; displayC++) {
      const r = flip ? 7 - displayR : displayR;
      const c = flip ? 7 - displayC : displayC;

      const cell = document.createElement("div");
      const isLightCell = (r + c) % 2 === 0;
      cell.className = `cell ${isLightCell ? "white-cell" : "black-cell"}`;

      const piece = boardGrid[r][c];
      if (piece) cell.textContent = PIECES[piece] || "";

      if (lastMove) {
        const to = squareToRC(lastMove.to);
        if (to.r === r && to.c === c) cell.classList.add("last-move");
      }

      if (selectedPos && selectedPos.r === r && selectedPos.c === c) {
        cell.classList.add("selected");
      }

      // AI 힌트: 이 칸의 기물이 스톡피시 추천 기물이면 파란색으로(나에게만 보임)
      if (aiHintEnabled && isMyTurnNow && aiSuggestion && aiSuggestion.from.r === r && aiSuggestion.from.c === c) {
        cell.classList.add("ai-suggest-piece");
      }

      if (isMyTurnNow) {
        const isPossible = possibleMoves.some(m => m.r === r && m.c === c);
        if (isPossible) {
          const isAiPick = aiHintEnabled && aiSuggestion && aiSuggestion.to.r === r && aiSuggestion.to.c === c;
          if (isAiPick) {
            cell.classList.add("possible-move-ai");
          } else {
            cell.classList.add(boardGrid[r][c] ? "possible-capture" : "possible-move");
          }
        }
      }

      cell.dataset.r = String(r);
      cell.dataset.c = String(c);
      cell.addEventListener("pointerdown", (e) => handleCellPointerDown(e, r, c, boardGrid, isMyTurnNow));
      boardEl.appendChild(cell);
    }
  }
}

function renderLog(total) {
  // 사용자가 로그를 위로 스크롤해서 옛날 수를 보고 있는 중이면 그 위치를 존중하고,
  // 이미 맨 아래(최신 수) 근처에 있었을 때만 새로 렌더링 후에도 맨 아래로 붙여줌
  const wasNearBottom = logPanelEl.scrollHeight - logPanelEl.scrollTop - logPanelEl.clientHeight < 40;

  logPanelEl.innerHTML = "";
  for (let i = 1; i <= total; i++) {
    const btn = document.createElement("button");
    btn.className = "log-btn" + (i === viewIndex ? " active" : "");
    const turnNum = Math.ceil(i / 2);
    const quality = moveQuality.get(i);
    const sanText = escapeHtmlLocal(history.sans[i - 1] ?? "?");
    btn.innerHTML = `${turnNum}. ${sanText}${quality ? ` <span class="move-quality">${quality}</span>` : ""}`;
    btn.addEventListener("click", () => {
      viewIndex = i;
      followLatest = viewIndex === total;
      renderBoardAndLog();
    });
    logPanelEl.appendChild(btn);
  }
  if (wasNearBottom) {
    logPanelEl.scrollTop = logPanelEl.scrollHeight;
  }
}

const RESULT_REASON_LABEL = {
  checkmate: "체크메이트",
  stalemate: "스테일메이트",
  threefold: "3회 반복",
  insufficient: "기물 부족으로 인한 무승부",
  "50move": "50수 규칙",
  resign: "기권",
  timeout: "시간 초과",
  left: "상대방 이탈",
};

function describeResult() {
  const reasonText = RESULT_REASON_LABEL[room.resultStatus] || "";

  if (!room.winner) {
    return { title: "무승부", subtitle: reasonText };
  }

  const winnerRole = room.winner === room.hostColor ? "host" : "challenger";
  let title;
  if (myRole === "spectator") {
    const winnerName = winnerRole === "host" ? (hostNickname || "방장") : (challengerNickname || "도전자");
    title = `${winnerName} 승리`;
  } else {
    title = myRole === winnerRole ? "승리했어요! 🎉" : "패배했어요";
  }
  return { title, subtitle: reasonText };
}

function showResult() {
  const key = room.gameOverAt || `${room.resultStatus || ""}-${room.winner || "draw"}`;
  if (key !== resultShownKey) {
    resultShownKey = key;
    resultDismissed = false;
  }
  if (resultDismissed) return;

  const { title, subtitle } = describeResult();

  if (!resultOverlayEl) {
    resultOverlayEl = document.createElement("div");
    resultOverlayEl.className = "xeon-result-overlay";
    resultOverlayEl.innerHTML = `
      <div class="xeon-result-box">
        <h2>${escapeHtmlLocal(title)}</h2>
        <p>${escapeHtmlLocal(subtitle)}</p>
        <div id="resultRematchArea"></div>
        <button type="button" class="xeon-btn" id="resultCloseBtn">기보 보기</button>
        <button type="button" class="xeon-btn" id="resultLeaveBtn">로비로</button>
      </div>
    `;
    document.body.appendChild(resultOverlayEl);
    document.getElementById("resultCloseBtn").addEventListener("click", dismissResultOverlay);
    document.getElementById("resultLeaveBtn").addEventListener("click", () => {
      localStorage.removeItem("xeon_last_room");
      window.location.href = "index.html";
    });
  }
  renderRematchIntoOverlay();
}

/* =========================================================
   재대국(구 "다시하기") — 결과 오버레이 안에 버튼/상태를 그려 넣음
   양쪽 다 눌러야 새 게임으로 리셋되고, 상대가 이미 나갔으면 버튼이 비활성화되고 ✕가 표시됨
========================================================= */
function renderRematchIntoOverlay() {
  if (!resultOverlayEl || !room) return;
  const area = document.getElementById("resultRematchArea");
  if (!area) return;

  const isPlayer = myRole === "host" || myRole === "challenger";
  if (!isPlayer) {
    area.innerHTML = "";
    return;
  }

  const oppLeftField = myRole === "host" ? "challengerLeft" : "hostLeft";
  if (room[oppLeftField]) {
    area.innerHTML = `<p class="xeon-undo-status">상대가 나가서 재대국할 수 없어요 ✕</p>`;
    return;
  }

  const myReadyField = myRole === "host" ? "hostRematchReady" : "challengerRematchReady";
  const oppReadyField = myRole === "host" ? "challengerRematchReady" : "hostRematchReady";
  const amReady = !!room[myReadyField];
  const oppReady = !!room[oppReadyField];

  area.innerHTML = `
    <button type="button" class="xeon-btn" id="resultRematchBtn"${amReady ? " disabled" : ""}>${amReady ? "✔ 재대국 준비" : "재대국"}</button>
    <p class="xeon-undo-status">${oppReady ? "상대가 재대국을 기다리고 있어요" : (amReady ? "상대의 재대국 수락을 기다리는 중이에요..." : "")}</p>
  `;
  const btn = document.getElementById("resultRematchBtn");
  if (btn && !amReady) btn.addEventListener("click", handleRematchClick);
}

async function handleRematchClick() {
  if (!room || room.status !== "finished" || myRole === "spectator") return;
  const btn = document.getElementById("resultRematchBtn");
  if (btn) btn.disabled = true;
  try {
    await callApi("/api/rematch", { roomId });
  } catch (e) {
    alert(e.message);
    if (btn) btn.disabled = false;
  }
}

function dismissResultOverlay() {
  resultDismissed = true;
  if (resultOverlayEl && resultOverlayEl.parentNode) {
    resultOverlayEl.parentNode.removeChild(resultOverlayEl);
  }
  resultOverlayEl = null;
}

function escapeHtmlLocal(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* =========================================================
   기물 선택 / 이동 (자기 턴 & 최신 수 상태일 때만)
   - 여기서 보여주는 "이동 가능 표시"는 순전히 UX용 미리보기이고,
     실제 합법성 최종 판정은 서버 /api/move가 함
========================================================= */
let selectedPos = null;
let possibleMoves = [];

// 드래그 진행 상태 (탭으로 선택 후 탭으로 이동하는 기존 방식과 함께 동작)
let dragFromCell = null;   // {r,c}
let dragMoved = false;
let dragStartXY = null;
let dragGhostEl = null;
let dragOriginCellEl = null;

function handleCellPointerDown(e, r, c, boardGrid, isMyTurnNow) {
  if (!isMyTurnNow) return;
  const piece = boardGrid[r][c];

  // 이미 선택된 기물이 있고, 지금 누른 칸이 이동 가능한 칸이면 바로 이동(탭-탭 방식)
  if (selectedPos && possibleMoves.some(m => m.r === r && m.c === c)) {
    const from = selectedPos;
    submitMove(from.r, from.c, r, c);
    selectedPos = null;
    possibleMoves = [];
    renderBoardAndLog();
    return;
  }

  const pieceIsMine = piece && (
    (myColor === "white" && piece === piece.toUpperCase()) ||
    (myColor === "black" && piece === piece.toLowerCase())
  );

  if (!pieceIsMine) {
    selectedPos = null;
    possibleMoves = [];
    renderBoardAndLog();
    return;
  }

  // 내 기물을 새로 선택: 이동 가능 칸 표시 + 드래그 시작 준비
  selectedPos = { r, c };
  const liveChess = new Chess(room.fen);
  const verboseMoves = liveChess.moves({ square: squareName(r, c), verbose: true });
  possibleMoves = verboseMoves.map(m => squareToRC(m.to));
  renderBoardAndLog();

  dragFromCell = { r, c };
  dragMoved = false;
  dragStartXY = { x: e.clientX, y: e.clientY };
  dragOriginCellEl = e.currentTarget;

  dragGhostEl = document.createElement("div");
  dragGhostEl.className = "drag-ghost";
  dragGhostEl.textContent = PIECES[piece] || "";
  document.body.appendChild(dragGhostEl);
  positionDragGhost(e.clientX, e.clientY);

  window.addEventListener("pointermove", handleDragMove);
  window.addEventListener("pointerup", handleDragEnd, { once: true });
}

function positionDragGhost(x, y) {
  if (!dragGhostEl) return;
  dragGhostEl.style.left = x + "px";
  dragGhostEl.style.top = y + "px";
}

function handleDragMove(e) {
  if (!dragGhostEl || !dragStartXY) return;
  const dx = e.clientX - dragStartXY.x;
  const dy = e.clientY - dragStartXY.y;
  if (!dragMoved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
    dragMoved = true;
    dragGhostEl.style.display = "flex";
    if (dragOriginCellEl) dragOriginCellEl.classList.add("dragging-origin");
    boardEl.classList.add("dragging-active");
  }
  if (dragMoved) {
    positionDragGhost(e.clientX, e.clientY);
    highlightDropTarget(e.clientX, e.clientY);
  }
}

function highlightDropTarget(x, y) {
  boardEl.querySelectorAll(".drop-hover").forEach((el) => el.classList.remove("drop-hover"));
  const el = document.elementFromPoint(x, y);
  const cellEl = el ? el.closest(".cell") : null;
  if (!cellEl || cellEl.dataset.r === undefined) return;
  const r = parseInt(cellEl.dataset.r, 10);
  const c = parseInt(cellEl.dataset.c, 10);
  if (possibleMoves.some(m => m.r === r && m.c === c)) {
    cellEl.classList.add("drop-hover");
  }
}

function handleDragEnd(e) {
  window.removeEventListener("pointermove", handleDragMove);
  boardEl.querySelectorAll(".drop-hover").forEach((el) => el.classList.remove("drop-hover"));
  if (dragGhostEl) { dragGhostEl.remove(); dragGhostEl = null; }
  if (dragOriginCellEl) { dragOriginCellEl.classList.remove("dragging-origin"); dragOriginCellEl = null; }
  boardEl.classList.remove("dragging-active");

  if (dragMoved && dragFromCell) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cellEl = el ? el.closest(".cell") : null;
    if (cellEl && cellEl.dataset.r !== undefined) {
      const r = parseInt(cellEl.dataset.r, 10);
      const c = parseInt(cellEl.dataset.c, 10);
      if (possibleMoves.some(m => m.r === r && m.c === c)) {
        submitMove(dragFromCell.r, dragFromCell.c, r, c);
      }
    }
    // 드래그를 시도했으면(성공/실패 모두) 선택 상태를 정리 — 탭-탭 방식은 선택을 유지해야 하므로 건드리지 않음
    selectedPos = null;
    possibleMoves = [];
    renderBoardAndLog();
  }

  dragFromCell = null;
  dragMoved = false;
  dragStartXY = null;
}

async function submitMove(fromR, fromC, toR, toC) {
  const from = squareName(fromR, fromC);
  const to = squareName(toR, toC);

  let needsPromotion = false;
  let optimisticGame = null;
  try {
    optimisticGame = new Chess(room.fen);
    const verboseMoves = optimisticGame.moves({ square: from, verbose: true });
    const target = verboseMoves.find(m => m.to === to);
    needsPromotion = !!(target && target.flags && target.flags.includes("p"));
  } catch (e) {
    optimisticGame = null;
  }

  let promotionPiece = undefined;
  if (needsPromotion) {
    const promotingColor = optimisticGame ? optimisticGame.turn() : (myColor === "black" ? "b" : "w");
    // AI 힌트가 켜져 있고, 지금 두려는 수가 AI가 추천한 바로 그 수라면 추천 기물을 파란 테두리로 보여줌
    const aiPick = (aiHintEnabled && aiSuggestion && aiSuggestion.promotion &&
      aiSuggestion.from.r === fromR && aiSuggestion.from.c === fromC &&
      aiSuggestion.to.r === toR && aiSuggestion.to.c === toC)
      ? aiSuggestion.promotion : null;
    promotionPiece = await askPromotionChoice(promotingColor, aiPick);
    if (!promotionPiece) {
      // 취소함 — 선택 상태만 정리하고 이동은 진행하지 않음
      selectedPos = null;
      possibleMoves = [];
      renderBoardAndLog();
      return;
    }
  }

  // 낙관적 업데이트: 서버 응답(왕복)을 기다리지 않고 바로 화면에 반영해서 체감 지연을 없앰.
  // 서버가 최종 검증하는 건 그대로 유지 — 실패하면 catch에서 원래 상태로 되돌림.
  const prevRoom = room;
  const prevHistory = history;
  if (optimisticGame) {
    try {
      const mv = optimisticGame.move({ from, to, promotion: needsPromotion ? promotionPiece : undefined });
      if (mv) {
        const optimisticMoves = [...(room.moves || []), mv.lan];
        room = {
          ...room,
          fen: optimisticGame.fen(),
          moves: optimisticMoves,
          turn: optimisticGame.turn() === "w" ? "white" : "black",
          lastMove: { from: mv.from, to: mv.to, promotion: mv.promotion || null, san: mv.san },
        };
        history = buildHistory(optimisticMoves);
        viewIndex = optimisticMoves.length;
        followLatest = true;
        selectedPos = null;
        possibleMoves = [];
        render();
      }
    } catch (e) {
      // 로컬 재현 실패해도(드물게 서버 상태와 어긋난 경우) 그냥 서버 응답만 기다림
    }
  }

  try {
    await callApi("/api/move", { roomId, from, to, promotion: needsPromotion ? promotionPiece : undefined });
    // 성공하면 곧이어 onSnapshot이 (타이머 등 세부 필드까지 포함한) 진짜 상태로 자연스럽게 덮어씀
  } catch (e) {
    console.error(e);
    // 서버가 거부한 수라면 낙관적으로 반영했던 걸 실제 상태로 되돌림
    room = prevRoom;
    history = prevHistory;
    render();
    alert("수를 둘 수 없어요: " + (e.message || "다시 시도해주세요"));
  }
}
