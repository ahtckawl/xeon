import { db, ensureSignedIn } from "./firebase-config.js";
import {
  doc, getDoc, onSnapshot, runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

/* =========================================================
   기본 세팅
========================================================= */
const params = new URLSearchParams(window.location.search);
const roomId = params.get("room");

const PIECES = {
  'r': '♜', 'n': '♞', 'b': '♝', 'q': '♛', 'k': '♚', 'p': '♟',
  'R': '♖', 'N': '♘', 'B': '♗', 'Q': '♕', 'K': '♔', 'P': '♙'
};

const initialBoard = [
  ['r','n','b','q','k','b','n','r'],
  ['p','p','p','p','p','p','p','p'],
  ['','','','','','','',''],
  ['','','','','','','',''],
  ['','','','','','','',''],
  ['','','','','','','',''],
  ['P','P','P','P','P','P','P','P'],
  ['R','N','B','Q','K','B','N','R']
];

let currentUser = null;
let roomRef = null;
let room = null;          // 파이어스토어에서 받아온 최신 room 문서
let myRole = null;        // 'host' | 'challenger' | 'spectator'
let myColor = null;       // 'white' | 'black' | null(관전자)

// 로컬 히스토리 열람 인덱스 (서버 상태와 별개, 보기 전용)
let viewIndex = 0;
let followLatest = true; // true면 새 수가 생길 때마다 자동으로 최신 수로 이동
let prevTurnForAnim = null;

/* =========================================================
   DOM 참조
========================================================= */
const waitingPhase = document.getElementById("waitingPhase");
const gamePhase = document.getElementById("gamePhase");
const roomTitleEl = document.getElementById("roomTitle");
const roomRuleSummaryEl = document.getElementById("roomRuleSummary");
const myReadyLabelEl = document.getElementById("myReadyLabel");
const readyBtn = document.getElementById("readyBtn");
const waitingStatusEl = document.getElementById("waitingStatus");

const boardEl = document.getElementById("board");
const opponentNameEl = document.getElementById("opponentName");
const opponentTimeEl = document.getElementById("opponentTime");
const myNameEl = document.getElementById("myName");
const myTimeEl = document.getElementById("myTime");
const statusEl = document.getElementById("gameStatus");

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
  bindUI();
  onSnapshot(roomRef, (docSnap) => {
    if (!docSnap.exists()) return;
    room = docSnap.data();
    render();
  });
}

/* =========================================================
   역할 배정 (트랜잭션으로 challenger 슬롯 안전하게 확보)
========================================================= */
async function joinAsRole(initialData) {
  if (initialData.hostId === currentUser.uid) {
    myRole = "host";
    return;
  }
  if (initialData.challengerId === currentUser.uid) {
    myRole = "challenger";
    return;
  }
  if (!initialData.challengerId) {
    // 도전자 슬롯이 비어있으면 선점 시도
    try {
      await runTransaction(db, async (tx) => {
        const fresh = await tx.get(roomRef);
        const data = fresh.data();
        if (data.hostId === currentUser.uid) return;
        if (!data.challengerId) {
          tx.update(roomRef, { challengerId: currentUser.uid });
        }
      });
      const after = await getDoc(roomRef);
      myRole = after.data().challengerId === currentUser.uid ? "challenger" : "spectator";
      return;
    } catch (e) {
      console.error(e);
    }
  }
  myRole = "spectator";
}

/* =========================================================
   준비 버튼
========================================================= */
function bindUI() {
  readyBtn.addEventListener("click", handleReadyClick);
  prevBtn.addEventListener("click", () => {
    viewIndex = Math.max(0, viewIndex - 1);
    const hist = room.moveHistory || [];
    followLatest = viewIndex === hist.length - 1;
    renderBoardAndLog();
  });
  nextBtn.addEventListener("click", () => {
    const hist = room.moveHistory || [];
    viewIndex = Math.min(hist.length - 1, viewIndex + 1);
    followLatest = viewIndex === hist.length - 1;
    renderBoardAndLog();
  });
  latestBtn.addEventListener("click", () => {
    const hist = room.moveHistory || [];
    viewIndex = hist.length - 1;
    followLatest = true;
    renderBoardAndLog();
  });
}

async function handleReadyClick() {
  if (myRole !== "host" && myRole !== "challenger") return;
  const field = myRole === "host" ? "hostReady" : "challengerReady";

  readyBtn.disabled = true;
  try {
    await runTransaction(db, async (tx) => {
      const fresh = await tx.get(roomRef);
      const data = fresh.data();
      if (data.status !== "waiting") return;

      const update = { [field]: true, lastActivityAt: serverTimestamp() };
      const hostReady = myRole === "host" ? true : data.hostReady;
      const challengerReady = myRole === "challenger" ? true : data.challengerReady;

      if (hostReady && challengerReady && data.challengerId) {
        // 둘 다 준비 완료 -> 선공 결정 + 게임 시작
        let hostColor;
        if (data.firstMoveRule === "host") hostColor = "white";
        else if (data.firstMoveRule === "challenger") hostColor = "black";
        else hostColor = Math.random() < 0.5 ? "white" : "black";
        const challengerColor = hostColor === "white" ? "black" : "white";
        const presetSeconds = (data.timeControl && data.timeControl.presetSeconds) || null;

        Object.assign(update, {
          status: "playing",
          hostColor,
          challengerColor,
          turn: "white",
          whiteTimeLeft: presetSeconds,
          blackTimeLeft: presetSeconds,
          turnStartedAt: serverTimestamp(),
          boardStr: boardToStr(initialBoard),
          castleFlags: {
            whiteKingMoved: false, whiteRookAMoved: false, whiteRookHMoved: false,
            blackKingMoved: false, blackRookAMoved: false, blackRookHMoved: false
          },
          enPassantTarget: null,
          halfMoveClock: 0,
          positionCounts: [],
          lastMove: null,
          resultStatus: null,
          winner: null,
          moveHistory: [{
            label: "시작",
            boardStr: boardToStr(initialBoard),
            turn: "white",
            castleFlags: {
              whiteKingMoved: false, whiteRookAMoved: false, whiteRookHMoved: false,
              blackKingMoved: false, blackRookAMoved: false, blackRookHMoved: false
            },
            enPassantTarget: null,
            lastMove: null
          }]
        });
      }
      tx.update(roomRef, update);
    });
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
  else myColor = null; // 관전자 (다음 단계에서 별도 처리)

  if (room.status === "waiting") {
    waitingPhase.style.display = "block";
    gamePhase.style.display = "none";
    renderWaitingPhase();
    return;
  }

  waitingPhase.style.display = "none";
  gamePhase.style.display = "block";

  const hist = room.moveHistory || [];
  if (followLatest) {
    viewIndex = hist.length - 1;
  } else if (viewIndex > hist.length - 1) {
    viewIndex = hist.length - 1;
  }
  if (viewIndex < 0) viewIndex = 0;

  renderNames();
  renderBoardAndLog();

  if (room.status === "finished") {
    showResult();
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

  const amReady = myRole === "host" ? room.hostReady : room.challengerReady;
  readyBtn.textContent = amReady ? "✔ 준비 완료" : "준비";
  readyBtn.disabled = amReady;
  myReadyLabelEl.textContent = myRole === "host" ? "방장 (나)" : "도전자 (나)";

  if (!room.challengerId) {
    waitingStatusEl.textContent = "도전자를 기다리는 중이에요...";
  } else {
    waitingStatusEl.textContent = "상대의 준비를 기다리는 중이에요...";
  }
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
   시간 표시 (클라이언트에서 서버 turnStartedAt 기준으로 계산)
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

  if (presetSeconds && room.turnStartedAt && room.turnStartedAt.toMillis) {
    const elapsed = (Date.now() - room.turnStartedAt.toMillis()) / 1000;
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
    await runTransaction(db, async (tx) => {
      const fresh = await tx.get(roomRef);
      const data = fresh.data();
      if (data.status !== "playing") return;
      const presetSeconds = data.timeControl && data.timeControl.presetSeconds;
      if (!presetSeconds || !data.turnStartedAt || !data.turnStartedAt.toMillis) return;

      const elapsed = (Date.now() - data.turnStartedAt.toMillis()) / 1000;
      const field = data.turn === "white" ? "whiteTimeLeft" : "blackTimeLeft";
      const left = data[field] - elapsed;
      if (left > 0) return;

      tx.update(roomRef, {
        status: "finished",
        resultStatus: "timeout",
        winner: data.turn === "white" ? "black" : "white"
      });
    });
  } catch (e) {
    console.error(e);
  } finally {
    timeoutClaimInFlight = false;
  }
}

function renderBoardAndLog() {
  const hist = room.moveHistory || [];
  const viewing = hist[viewIndex] || hist[hist.length - 1];
  if (!viewing) return;

  const boardState = strToBoard(viewing.boardStr);
  const lastMove = viewing.lastMove;
  const isLatest = viewIndex === hist.length - 1;
  const isMyTurnNow = isLatest && myColor && room.turn === myColor && room.status === "playing";

  drawBoard(boardState, lastMove, isMyTurnNow);
  renderLog(hist);

  prevBtn.disabled = viewIndex === 0;
  nextBtn.disabled = viewIndex === hist.length - 1;
  latestBtn.disabled = isLatest;
}

function drawBoard(boardState, lastMove, isMyTurnNow) {
  boardEl.innerHTML = "";
  boardEl.classList.toggle("flipped", myColor === "black");

  // 관전자 방향/반전 버튼은 다음 단계에서 구현 예정. 관전자는 우선 백 기준 고정.
  const flip = myColor === "black";

  for (let displayR = 0; displayR < 8; displayR++) {
    for (let displayC = 0; displayC < 8; displayC++) {
      const r = flip ? 7 - displayR : displayR;
      const c = flip ? 7 - displayC : displayC;

      const cell = document.createElement("div");
      const isLightCell = (r + c) % 2 === 0;
      cell.className = `cell ${isLightCell ? "white-cell" : "black-cell"}`;

      const piece = boardState[r][c];
      if (piece) cell.textContent = PIECES[piece] || "";

      if (lastMove && lastMove.toR === r && lastMove.toC === c) {
        cell.classList.add("last-move");
      }

      if (selectedPos && selectedPos.r === r && selectedPos.c === c) {
        cell.classList.add("selected");
      }

      if (isMyTurnNow) {
        const isPossible = possibleMoves.some(m => m.r === r && m.c === c);
        if (isPossible) {
          cell.classList.add(boardState[r][c] ? "possible-capture" : "possible-move");
        }
      }

      cell.addEventListener("click", () => handleCellClick(r, c, boardState, isMyTurnNow));
      boardEl.appendChild(cell);
    }
  }
}

function renderLog(hist) {
  logPanelEl.innerHTML = "";
  hist.forEach((item, index) => {
    if (index === 0) return;
    const btn = document.createElement("button");
    btn.className = "log-btn" + (index === viewIndex ? " active" : "");
    const turnNum = Math.ceil(index / 2);
    btn.textContent = `${turnNum}. ${item.label}`;
    btn.addEventListener("click", () => {
      viewIndex = index;
      followLatest = viewIndex === hist.length - 1;
      renderBoardAndLog();
    });
    logPanelEl.appendChild(btn);
  });
  logPanelEl.scrollTop = logPanelEl.scrollHeight;
}

function showResult() {
  // 결과 화면(승자 표시 + 다시하기/나가기)은 다음 단계에서 구현 예정
}

/* =========================================================
   기물 선택 / 이동 (자기 턴 & 최신 수 상태일 때만)
========================================================= */
let selectedPos = null;
let possibleMoves = [];

function handleCellClick(r, c, boardState, isMyTurnNow) {
  if (!isMyTurnNow) return;
  const piece = boardState[r][c];

  if (selectedPos && possibleMoves.some(m => m.r === r && m.c === c)) {
    submitMove(selectedPos.r, selectedPos.c, r, c);
    selectedPos = null;
    possibleMoves = [];
    return;
  }

  const pieceIsMine = piece && ((myColor === "white" && isWhite(piece)) || (myColor === "black" && isBlack(piece)));
  if (pieceIsMine) {
    selectedPos = { r, c };
    possibleMoves = getLegalMoves(boardState, r, c, piece);
  } else {
    selectedPos = null;
    possibleMoves = [];
  }
  renderBoardAndLog();
}

async function submitMove(fromR, fromC, toR, toC) {
  try {
    await runTransaction(db, async (tx) => {
      const fresh = await tx.get(roomRef);
      const data = fresh.data();
      if (data.status !== "playing") return;
      if (data.turn !== myColor) return;

      const boardState = strToBoard(data.boardStr);
      const piece = boardState[fromR][fromC];
      if (!piece) return;

      const legalMoves = getLegalMoves(boardState, fromR, fromC, piece);
      const moveInfo = legalMoves.find(m => m.r === toR && m.c === toC);
      if (!moveInfo) return;

      const result = applyMove(boardState, fromR, fromC, toR, toC, moveInfo, data);
      tx.update(roomRef, result.update);
    });
  } catch (e) {
    console.error(e);
  }
}

/* =========================================================
   수 적용 (순수 함수: 새 상태를 계산해서 반환)
========================================================= */
function applyMove(boardState, fromR, fromC, toR, toC, moveInfo, data) {
  const castleFlags = { ...data.castleFlags };
  let enPassantTarget = data.enPassantTarget || null;
  let halfMoveClock = data.halfMoveClock || 0;
  const positionCounts = (data.positionCounts || []).map(x => ({ ...x }));

  const piece = boardState[fromR][fromC];
  const movedType = piece.toLowerCase();
  const wasCapture = !!boardState[toR][toC] || !!moveInfo.enPassant;

  const fromCol = String.fromCharCode(97 + fromC);
  const toCol = String.fromCharCode(97 + toC);
  let moveLabel = `${PIECES[piece]} ${fromCol}${8 - fromR} \u2794 ${toCol}${8 - toR}`;

  updateCastleFlags(castleFlags, fromR, fromC, piece);
  if (boardState[toR][toC]) updateCastleFlagsOnCapture(castleFlags, toR, toC);

  if (moveInfo.enPassant) boardState[fromR][toC] = "";

  boardState[toR][toC] = boardState[fromR][fromC];
  boardState[fromR][fromC] = "";

  if (moveInfo.castle === "king") {
    boardState[fromR][5] = boardState[fromR][7];
    boardState[fromR][7] = "";
    moveLabel = "O-O";
  } else if (moveInfo.castle === "queen") {
    boardState[fromR][3] = boardState[fromR][0];
    boardState[fromR][0] = "";
    moveLabel = "O-O-O";
  }

  if (movedType === "p" && Math.abs(toR - fromR) === 2) {
    enPassantTarget = { r: (fromR + toR) / 2, c: fromC };
  } else {
    enPassantTarget = null;
  }

  // 승진: 1단계에서는 자동으로 퀸으로 승진 처리 (선택 모달은 다음 단계에서 추가 예정)
  if (movedType === "p" && (toR === 0 || toR === 7)) {
    const color = isWhite(piece) ? "white" : "black";
    const promoted = color === "white" ? "Q" : "q";
    boardState[toR][toC] = promoted;
    moveLabel = `${fromCol}${8 - fromR} \u2794 ${toCol}${8 - toR}=${PIECES[promoted]}`;
  }

  if (movedType === "p" || wasCapture) halfMoveClock = 0; else halfMoveClock++;

  const newTurn = data.turn === "white" ? "black" : "white";
  const boardStr = boardToStr(boardState);
  const sig = getPositionSignature(boardStr, newTurn, castleFlags, enPassantTarget);
  const found = positionCounts.find(p => p.sig === sig);
  if (found) found.count++; else positionCounts.push({ sig, count: 1 });

  const lastMove = { fromR, fromC, toR, toC };
  const historyEntry = { label: moveLabel, boardStr, turn: newTurn, castleFlags, enPassantTarget, lastMove };
  const moveHistory = [...(data.moveHistory || []), historyEntry];

  const update = {
    boardStr, turn: newTurn, castleFlags, enPassantTarget, halfMoveClock,
    positionCounts, lastMove, moveHistory,
    lastActivityAt: serverTimestamp(),
    turnStartedAt: serverTimestamp()
  };

  const presetSeconds = data.timeControl && data.timeControl.presetSeconds;
  if (presetSeconds) {
    const incrementSeconds = (data.timeControl && data.timeControl.incrementSeconds) || 0;
    const startedAtMillis = data.turnStartedAt && data.turnStartedAt.toMillis ? data.turnStartedAt.toMillis() : Date.now();
    const elapsedSec = Math.max(0, (Date.now() - startedAtMillis) / 1000);
    const field = data.turn === "white" ? "whiteTimeLeft" : "blackTimeLeft";
    const currentLeft = typeof data[field] === "number" ? data[field] : presetSeconds;
    update[field] = Math.max(0, currentLeft - elapsedSec + incrementSeconds);
  }

  const info = getGameStatusInfo(boardState, newTurn);
  if (!info.hasMoves) {
    update.status = "finished";
    update.resultStatus = info.inCheck ? "checkmate" : "stalemate";
    update.winner = info.inCheck ? data.turn : null;
  } else if (isInsufficientMaterial(boardState)) {
    update.status = "finished";
    update.resultStatus = "insufficient";
    update.winner = null;
  } else if (halfMoveClock >= 100) {
    update.status = "finished";
    update.resultStatus = "50move";
    update.winner = null;
  } else if (found && found.count >= 3) {
    update.status = "finished";
    update.resultStatus = "threefold";
    update.winner = null;
  }

  return { update };
}

/* =========================================================
   체스 규칙 엔진 (기존 로직 재사용, boardState를 인자로 받도록 조정)
========================================================= */
function isWhite(piece) { return piece && piece === piece.toUpperCase(); }
function isBlack(piece) { return piece && piece === piece.toLowerCase(); }

function boardToStr(b) { return b.map(row => row.map(c => c || ".").join("")).join(""); }
function strToBoard(s) {
  const b = [];
  for (let r = 0; r < 8; r++) {
    const row = [];
    for (let c = 0; c < 8; c++) {
      const ch = s[r * 8 + c];
      row.push(ch === "." ? "" : ch);
    }
    b.push(row);
  }
  return b;
}

function getPositionSignature(boardStr, turn, castleFlags, enPassantTarget) {
  let castling = "";
  if (!castleFlags.whiteKingMoved && !castleFlags.whiteRookHMoved) castling += "K";
  if (!castleFlags.whiteKingMoved && !castleFlags.whiteRookAMoved) castling += "Q";
  if (!castleFlags.blackKingMoved && !castleFlags.blackRookHMoved) castling += "k";
  if (!castleFlags.blackKingMoved && !castleFlags.blackRookAMoved) castling += "q";
  if (!castling) castling = "-";
  const ep = enPassantTarget ? `${enPassantTarget.r}${enPassantTarget.c}` : "-";
  return `${boardStr} ${turn} ${castling} ${ep}`;
}

function updateCastleFlags(castleFlags, fromR, fromC, piece) {
  const type = piece.toLowerCase();
  if (type === "k") {
    if (isWhite(piece)) castleFlags.whiteKingMoved = true; else castleFlags.blackKingMoved = true;
  } else if (type === "r") {
    if (fromR === 7 && fromC === 0) castleFlags.whiteRookAMoved = true;
    if (fromR === 7 && fromC === 7) castleFlags.whiteRookHMoved = true;
    if (fromR === 0 && fromC === 0) castleFlags.blackRookAMoved = true;
    if (fromR === 0 && fromC === 7) castleFlags.blackRookHMoved = true;
  }
}
function updateCastleFlagsOnCapture(castleFlags, r, c) {
  if (r === 7 && c === 0) castleFlags.whiteRookAMoved = true;
  if (r === 7 && c === 7) castleFlags.whiteRookHMoved = true;
  if (r === 0 && c === 0) castleFlags.blackRookAMoved = true;
  if (r === 0 && c === 7) castleFlags.blackRookHMoved = true;
}

function getValidMoves(boardState, r, c, piece, castleFlags, enPassantTarget) {
  const moves = [];
  const type = piece.toLowerCase();
  const isW = isWhite(piece);

  function addMove(nr, nc) {
    if (nr < 0 || nr > 7 || nc < 0 || nc > 7) return false;
    const target = boardState[nr][nc];
    if (!target) { moves.push({ r: nr, c: nc }); return true; }
    if ((isW && isBlack(target)) || (!isW && isWhite(target))) moves.push({ r: nr, c: nc });
    return false;
  }

  if (type === "p") {
    const dir = isW ? -1 : 1;
    if (!boardState[r + dir]?.[c]) {
      addMove(r + dir, c);
      const startRow = isW ? 6 : 1;
      if (r === startRow && !boardState[r + 2 * dir]?.[c]) addMove(r + 2 * dir, c);
    }
    [-1, 1].forEach(dc => {
      const target = boardState[r + dir]?.[c + dc];
      if (target && ((isW && isBlack(target)) || (!isW && isWhite(target)))) {
        moves.push({ r: r + dir, c: c + dc });
      }
    });
    if (enPassantTarget) {
      [-1, 1].forEach(dc => {
        if (r + dir === enPassantTarget.r && c + dc === enPassantTarget.c) {
          moves.push({ r: enPassantTarget.r, c: enPassantTarget.c, enPassant: true });
        }
      });
    }
  } else if (type === "n") {
    [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]].forEach(([dr, dc]) => addMove(r + dr, c + dc));
  } else {
    let dirs = [];
    if (type === "r" || type === "q") dirs.push(...[[1,0],[-1,0],[0,1],[0,-1]]);
    if (type === "b" || type === "q") dirs.push(...[[1,1],[1,-1],[-1,1],[-1,-1]]);
    if (type === "k") {
      [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]].forEach(([dr, dc]) => addMove(r + dr, c + dc));
      const homeRow = isW ? 7 : 0;
      if (r === homeRow && c === 4) {
        const kingMoved = isW ? castleFlags.whiteKingMoved : castleFlags.blackKingMoved;
        const color = isW ? "white" : "black";
        const enemyColor = isW ? "black" : "white";
        if (!kingMoved && !isInCheck(boardState, color)) {
          const rookHMoved = isW ? castleFlags.whiteRookHMoved : castleFlags.blackRookHMoved;
          if (!rookHMoved && boardState[homeRow][7] === (isW ? "R" : "r") &&
              !boardState[homeRow][5] && !boardState[homeRow][6] &&
              !isSquareAttacked(boardState, homeRow, 5, enemyColor) && !isSquareAttacked(boardState, homeRow, 6, enemyColor)) {
            moves.push({ r: homeRow, c: 6, castle: "king" });
          }
          const rookAMoved = isW ? castleFlags.whiteRookAMoved : castleFlags.blackRookAMoved;
          if (!rookAMoved && boardState[homeRow][0] === (isW ? "R" : "r") &&
              !boardState[homeRow][1] && !boardState[homeRow][2] && !boardState[homeRow][3] &&
              !isSquareAttacked(boardState, homeRow, 2, enemyColor) && !isSquareAttacked(boardState, homeRow, 3, enemyColor)) {
            moves.push({ r: homeRow, c: 2, castle: "queen" });
          }
        }
      }
    } else {
      dirs.forEach(([dr, dc]) => {
        let step = 1;
        while (addMove(r + dr * step, c + dc * step)) step++;
      });
    }
  }
  return moves;
}

function findKing(boardState, color) {
  const kingChar = color === "white" ? "K" : "k";
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (boardState[r][c] === kingChar) return { r, c };
  return null;
}

function getAttackSquares(boardState, r, c, piece) {
  const type = piece.toLowerCase();
  const squares = [];
  function tryAdd(nr, nc) {
    if (nr < 0 || nr > 7 || nc < 0 || nc > 7) return false;
    squares.push({ r: nr, c: nc });
    return !boardState[nr][nc];
  }
  if (type === "p") {
    const dir = isWhite(piece) ? -1 : 1;
    [-1, 1].forEach(dc => {
      const nr = r + dir, nc = c + dc;
      if (nr >= 0 && nr <= 7 && nc >= 0 && nc <= 7) squares.push({ r: nr, c: nc });
    });
  } else if (type === "n") {
    [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]].forEach(([dr, dc]) => {
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr <= 7 && nc >= 0 && nc <= 7) squares.push({ r: nr, c: nc });
    });
  } else if (type === "k") {
    [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]].forEach(([dr, dc]) => {
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr <= 7 && nc >= 0 && nc <= 7) squares.push({ r: nr, c: nc });
    });
  } else {
    let dirs = [];
    if (type === "r" || type === "q") dirs.push([1,0],[-1,0],[0,1],[0,-1]);
    if (type === "b" || type === "q") dirs.push([1,1],[1,-1],[-1,1],[-1,-1]);
    dirs.forEach(([dr, dc]) => {
      let step = 1;
      while (tryAdd(r + dr * step, c + dc * step)) step++;
    });
  }
  return squares;
}

function isSquareAttacked(boardState, r, c, byColor) {
  for (let rr = 0; rr < 8; rr++) {
    for (let cc = 0; cc < 8; cc++) {
      const p = boardState[rr][cc];
      if (!p) continue;
      const pIsWhite = isWhite(p);
      if ((byColor === "white" && !pIsWhite) || (byColor === "black" && pIsWhite)) continue;
      if (getAttackSquares(boardState, rr, cc, p).some(m => m.r === r && m.c === c)) return true;
    }
  }
  return false;
}

function isInCheck(boardState, color) {
  const kingPos = findKing(boardState, color);
  if (!kingPos) return false;
  const enemyColor = color === "white" ? "black" : "white";
  return isSquareAttacked(boardState, kingPos.r, kingPos.c, enemyColor);
}

function getLegalMoves(boardState, r, c, piece) {
  const castleFlags = room.castleFlags;
  const enPassantTarget = room.enPassantTarget;
  const pseudo = getValidMoves(boardState, r, c, piece, castleFlags, enPassantTarget);
  const color = isWhite(piece) ? "white" : "black";
  return pseudo.filter(m => {
    const backupFrom = boardState[r][c];
    const backupTo = boardState[m.r][m.c];
    let epR, epC, backupEp;
    boardState[m.r][m.c] = boardState[r][c];
    boardState[r][c] = "";
    if (m.enPassant) { epR = r; epC = m.c; backupEp = boardState[epR][epC]; boardState[epR][epC] = ""; }
    const stillInCheck = isInCheck(boardState, color);
    boardState[r][c] = backupFrom;
    boardState[m.r][m.c] = backupTo;
    if (m.enPassant) boardState[epR][epC] = backupEp;
    return !stillInCheck;
  });
}

function getGameStatusInfo(boardState, color) {
  const inCheck = isInCheck(boardState, color);
  let hasMoves = false;
  for (let r = 0; r < 8 && !hasMoves; r++) {
    for (let c = 0; c < 8 && !hasMoves; c++) {
      const p = boardState[r][c];
      if (!p) continue;
      const pColor = isWhite(p) ? "white" : "black";
      if (pColor !== color) continue;
      const castleFlags = room.castleFlags, enPassantTarget = room.enPassantTarget;
      const pseudo = getValidMoves(boardState, r, c, p, castleFlags, enPassantTarget);
      const legal = pseudo.filter(m => {
        const backupFrom = boardState[r][c];
        const backupTo = boardState[m.r][m.c];
        boardState[m.r][m.c] = boardState[r][c];
        boardState[r][c] = "";
        const stillInCheck = isInCheck(boardState, color);
        boardState[r][c] = backupFrom;
        boardState[m.r][m.c] = backupTo;
        return !stillInCheck;
      });
      if (legal.length > 0) hasMoves = true;
    }
  }
  return { inCheck, hasMoves };
}

function isInsufficientMaterial(boardState) {
  const whitePieces = [], blackPieces = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = boardState[r][c];
      if (!p || p.toLowerCase() === "k") continue;
      (isWhite(p) ? whitePieces : blackPieces).push({ type: p.toLowerCase(), r, c });
    }
  }
  const all = [...whitePieces, ...blackPieces];
  if (all.length === 0) return true;
  if (all.length === 1 && (all[0].type === "b" || all[0].type === "n")) return true;
  if (whitePieces.length === 1 && blackPieces.length === 1 && whitePieces[0].type === "b" && blackPieces[0].type === "b") {
    const squareColor = (r, c) => (r + c) % 2;
    if (squareColor(whitePieces[0].r, whitePieces[0].c) === squareColor(blackPieces[0].r, blackPieces[0].c)) return true;
  }
  return false;
}
