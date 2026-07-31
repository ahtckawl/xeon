import { db, ensureSignedIn } from "./firebase-config.js";
import { doc, getDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { isAdmin, promptAdminLogin, getAdminPassword } from "./admin.js";
import { callApi } from "./api.js";
import { Chess } from "https://esm.sh/chess.js@1.0.0-beta.8";

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
  for (const lan of movesArr || []) {
    const from = lan.slice(0, 2);
    const to = lan.slice(2, 4);
    const promotion = lan.slice(4) || undefined;
    let mv = null;
    try { mv = chess.move({ from, to, promotion }); } catch (e) { mv = null; }
    sans.push(mv ? mv.san : "?");
    boards.push(toBoardGrid(chess));
    lastMoves.push({ from, to });
  }
  return { boards, sans, lastMoves };
}

let currentUser = null;
let roomRef = null;
let room = null;
let history = { boards: [toBoardGrid(new Chess())], sans: [], lastMoves: [null] };
let myRole = null;
let myColor = null;

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
const myReadyLabelEl = document.getElementById("myReadyLabel");
const readyBtn = document.getElementById("readyBtn");
const leaveWaitingBtn = document.getElementById("leaveWaitingBtn");
const waitingStatusEl = document.getElementById("waitingStatus");

const boardEl = document.getElementById("board");
const opponentNameEl = document.getElementById("opponentName");
const opponentTimeEl = document.getElementById("opponentTime");
const myNameEl = document.getElementById("myName");
const myTimeEl = document.getElementById("myTime");
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
  roomRef = doc(db, "rooms", roomId);

  const snap = await getDoc(roomRef);
  if (!snap.exists()) {
    document.body.innerHTML = "<p style='color:#fff;padding:24px;'>존재하지 않는 방이에요.</p>";
    return;
  }

  await joinAsRole(snap.data());
  buildExtraUI();
  bindUI();
  startHeartbeat();
  startDisconnectWatcher();
  updateAdminUI();

  onSnapshot(roomRef, (docSnap) => {
    if (!docSnap.exists()) {
      if (roomGoneHandled) return;
      roomGoneHandled = true;
      alert("삭제된 방입니다");
      window.location.href = "index.html";
      return;
    }
    room = docSnap.data();
    history = buildHistory(room.moves);
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
      .xeon-controls { display:flex; gap:8px; align-items:stretch; margin-top:10px; flex-wrap:wrap; }
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

  gamePhase.appendChild(controls);
}

/* =========================================================
   역할 배정 (도전자 슬롯 선점은 서버 /api/join이 경쟁 상황까지 안전하게 처리)
========================================================= */
async function joinAsRole(initialData) {
  if (initialData.hostId === currentUser.uid) { myRole = "host"; return; }
  if (initialData.challengerId === currentUser.uid) { myRole = "challenger"; return; }
  if (!initialData.challengerId) {
    try {
      const res = await callApi("/api/join", { roomId });
      myRole = res.role;
      return;
    } catch (e) {
      console.error(e);
    }
  }
  myRole = "spectator";
}

/* =========================================================
   접속 상태 — Firestore 하트비트 + 서버 검증 기반 끊김 감지
   (클라이언트가 "상대 끊겼다"고 주장해도, 서버가 하트비트 타임스탬프로 직접 재확인함)
========================================================= */
function startHeartbeat() {
  if (myRole !== "host" && myRole !== "challenger") return;
  const send = () => callApi("/api/heartbeat", { roomId }).catch(() => {});
  send();
  setInterval(send, 5000);
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
  });
  nextBtn.addEventListener("click", () => {
    const total = (room.moves || []).length;
    viewIndex = Math.min(total, viewIndex + 1);
    followLatest = viewIndex === total;
    renderBoardAndLog();
  });
  latestBtn.addEventListener("click", () => {
    viewIndex = (room.moves || []).length;
    followLatest = true;
    renderBoardAndLog();
  });

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
  try {
    await callApi("/api/ready", { roomId, ready: true });
  } catch (e) {
    console.error(e);
    readyBtn.disabled = false;
  }
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

  flipBtn.style.display = myRole === "spectator" ? "inline-block" : "none";

  if (room.status !== "playing" || !isPlayer) {
    undoBtn.style.display = "none";
    undoStatusEl.textContent = "";
    clearUndoTimer();
    return;
  }

  const pending = room.undoRequest;

  if (pending && pending.by === myRole) {
    // 내가 요청함 → 상대 응답(또는 5초 시간 초과) 대기, 5초 지나면 스스로 취소
    undoBtn.style.display = "none";
    undoStatusEl.textContent = "무르기 요청을 보냈어요";
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
    startUndoTimer(pending.requestedAt, autoDeclineUndo);
    return;
  }

  clearUndoTimer();
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

  if (myRole === "spectator") {
    waitingStatusEl.textContent = "게임이 시작되기를 기다리는 중이에요 (관전자)";
    readyBtn.style.display = "none";
    myReadyLabelEl.style.display = "none";
    return;
  }

  myReadyLabelEl.style.display = "inline";
  myReadyLabelEl.textContent = myRole === "host" ? "방장 (나)" : "도전자 (나)";

  if (myRole === "host" && !room.challengerId) {
    readyBtn.style.display = "none";
    waitingStatusEl.textContent = "도전자를 기다리는 중이에요...";
    return;
  }

  const amReady = myRole === "host" ? room.hostReady : room.challengerReady;
  readyBtn.style.display = "inline-block";
  readyBtn.textContent = amReady ? "✔ 준비 완료" : "준비";
  readyBtn.disabled = amReady;
  waitingStatusEl.textContent = "상대의 준비를 기다리는 중이에요...";
}

function renderNames() {
  const myLabel = myRole === "host" ? "방장 (나)" : "도전자 (나)";
  const oppLabel = myRole === "host" ? "도전자" : "방장";
  myNameEl.textContent = myLabel;
  opponentNameEl.textContent = oppLabel;

  const iAmTurn = myColor === room.turn;
  myNameEl.classList.toggle("turn-active", iAmTurn);
  opponentNameEl.classList.toggle("turn-active", !iAmTurn);

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

  const myLeft = myColor === "white" ? whiteLeft : blackLeft;
  const oppLeft = myColor === "white" ? blackLeft : whiteLeft;
  myTimeEl.textContent = formatTime(myLeft);
  opponentTimeEl.textContent = formatTime(oppLeft);

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
   보드 / 로그 렌더링
========================================================= */
function renderBoardAndLog() {
  const total = (room.moves || []).length;
  const boardGrid = history.boards[viewIndex] ?? history.boards[history.boards.length - 1];
  const lastMove = history.lastMoves[viewIndex] ?? null;
  const isLatest = viewIndex === total;
  const isMyTurnNow = isLatest && myColor && room.turn === myColor && room.status === "playing";

  drawBoard(boardGrid, lastMove, isMyTurnNow);
  renderLog(total);

  prevBtn.disabled = viewIndex === 0;
  nextBtn.disabled = viewIndex === total;
  latestBtn.disabled = isLatest;
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

      if (isMyTurnNow) {
        const isPossible = possibleMoves.some(m => m.r === r && m.c === c);
        if (isPossible) {
          cell.classList.add(boardGrid[r][c] ? "possible-capture" : "possible-move");
        }
      }

      cell.addEventListener("click", () => handleCellClick(r, c, boardGrid, isMyTurnNow));
      boardEl.appendChild(cell);
    }
  }
}

function renderLog(total) {
  logPanelEl.innerHTML = "";
  for (let i = 1; i <= total; i++) {
    const btn = document.createElement("button");
    btn.className = "log-btn" + (i === viewIndex ? " active" : "");
    const turnNum = Math.ceil(i / 2);
    btn.textContent = `${turnNum}. ${history.sans[i - 1] ?? "?"}`;
    btn.addEventListener("click", () => {
      viewIndex = i;
      followLatest = viewIndex === total;
      renderBoardAndLog();
    });
    logPanelEl.appendChild(btn);
  }
  logPanelEl.scrollTop = logPanelEl.scrollHeight;
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
    title = winnerRole === "host" ? "방장 승리" : "도전자 승리";
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
  if (resultDismissed || resultOverlayEl) return;

  const { title, subtitle } = describeResult();

  resultOverlayEl = document.createElement("div");
  resultOverlayEl.className = "xeon-result-overlay";
  resultOverlayEl.innerHTML = `
    <div class="xeon-result-box">
      <h2>${escapeHtmlLocal(title)}</h2>
      <p>${escapeHtmlLocal(subtitle)}</p>
      <button type="button" class="xeon-btn" id="resultCloseBtn">기보 보기</button>
      <button type="button" class="xeon-btn" id="resultLeaveBtn">로비로</button>
    </div>
  `;
  document.body.appendChild(resultOverlayEl);
  document.getElementById("resultCloseBtn").addEventListener("click", dismissResultOverlay);
  document.getElementById("resultLeaveBtn").addEventListener("click", () => {
    window.location.href = "index.html";
  });
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

function handleCellClick(r, c, boardGrid, isMyTurnNow) {
  if (!isMyTurnNow) return;
  const piece = boardGrid[r][c];

  if (selectedPos && possibleMoves.some(m => m.r === r && m.c === c)) {
    submitMove(selectedPos.r, selectedPos.c, r, c);
    selectedPos = null;
    possibleMoves = [];
    return;
  }

  const pieceIsMine = piece && (
    (myColor === "white" && piece === piece.toUpperCase()) ||
    (myColor === "black" && piece === piece.toLowerCase())
  );

  if (pieceIsMine) {
    selectedPos = { r, c };
    const liveChess = new Chess(room.fen);
    const verboseMoves = liveChess.moves({ square: squareName(r, c), verbose: true });
    possibleMoves = verboseMoves.map(m => squareToRC(m.to));
  } else {
    selectedPos = null;
    possibleMoves = [];
  }
  renderBoardAndLog();
}

async function submitMove(fromR, fromC, toR, toC) {
  const from = squareName(fromR, fromC);
  const to = squareName(toR, toC);

  let needsPromotion = false;
  try {
    const liveChess = new Chess(room.fen);
    const verboseMoves = liveChess.moves({ square: from, verbose: true });
    const target = verboseMoves.find(m => m.to === to);
    needsPromotion = !!(target && target.flags && target.flags.includes("p"));
  } catch (e) {
    // 프로모션 여부 확인 실패해도 서버가 최종 검증하니 무시하고 진행
  }

  try {
    await callApi("/api/move", { roomId, from, to, promotion: needsPromotion ? "q" : undefined });
  } catch (e) {
    console.error(e);
  }
}
