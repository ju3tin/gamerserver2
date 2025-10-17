// controllers/GameController.js

// ----------------- Imports -----------------
const crypto = require("crypto");
const GameRound = require("../models/GameRound");
const User = require("../models/User");
const ProvablyFairSeed = require("../models/ProvablyFairSeed");

// ----------------- Game State -----------------
let currentMultiplier = 1.0;    // Live multiplier (full precision)
let gameState = "waiting";      // "waiting" | "running" | "ended"
let isRunning = false;          // Prevent multiple intervals
let timeElapsed = 0;            // Timer for exponential growth

// ----------------- Utility Functions -----------------
function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

// Generate a 32-byte random server seed
function generateServerSeed() {
  return crypto.randomBytes(32).toString("hex");
}

// Provably fair multiplier calculation
function getBustMultiplier(hash) {
  const h = parseInt(hash.slice(0, 13), 16);
  const e = 2 ** 52;

  if (h % 33 === 0) return 1.01; // instant crash chance, minimum 1.01
  const result = (100 * (e - h)) / (e - 1);

  return Math.max(Math.floor(result) / 100, 1.01); // minimum 1.01
}

// Combine serverSeed, clientSeed, and nonce for deterministic hash
function getRoundHash(serverSeed, clientSeed, nonce) {
  return sha256(`${serverSeed}:${clientSeed}:${nonce}`);
}

// ----------------- Broadcast Helper -----------------
function broadcast(wss, msg) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(JSON.stringify(msg));
  });
}

// ----------------- Provably Fair Seed System -----------------
async function ensureSeed() {
  let seedDoc = await ProvablyFairSeed.findOne({ revealed: false });
  if (!seedDoc) {
    const serverSeed = generateServerSeed();
    const serverSeedHash = sha256(serverSeed);
    seedDoc = new ProvablyFairSeed({ serverSeed, serverSeedHash, revealed: false });
    await seedDoc.save();
  }
  return seedDoc;
}

// ----------------- Start Game -----------------
async function startGame(wss) {
  try {
    // Reset game state
    gameState = "waiting";
    isRunning = false;
    currentMultiplier = 1.0;
    timeElapsed = 0;

    // Ensure server seed exists
    const seedDoc = await ensureSeed();

    // Create new round in DB
    const round = new GameRound({
      startTime: new Date(),
      crashMultiplier: 0,
      bets: [],
      seedHash: seedDoc.serverSeedHash,
    });
    await round.save();

    broadcast(wss, { action: "GAME_WAITING", message: "Place your bets!" });

    // ----------------- Countdown Phase -----------------
    let countdown = 10;
    const countdownInterval = setInterval(() => {
      broadcast(wss, { action: "COUNTDOWN", time: countdown });
      countdown--;
      if (countdown < 0) clearInterval(countdownInterval);
    }, 1000);

    // ----------------- Start Round -----------------
    setTimeout(async () => {
      gameState = "running";
      isRunning = true;

      // Generate deterministic crash point
      const nonce = await GameRound.countDocuments();
      const clientSeed = "global_client_seed"; // replace with per-user seeds if desired
      const roundHash = getRoundHash(seedDoc.serverSeed, clientSeed, nonce);
      const crashPoint = getBustMultiplier(roundHash);

      round.crashMultiplier = crashPoint;
      round.roundHash = roundHash;
      await round.save();

      broadcast(wss, {
        action: "ROUND_STARTED",
        roundId: round._id,
        seedHash: seedDoc.serverSeedHash,
      });

      console.log(`🚀 Round started. Crash at ${crashPoint}x`);

      // ----------------- Multiplier Loop -----------------
      timeElapsed = 0;
      const interval = setInterval(async () => {
        timeElapsed += 0.05; // 50ms per tick

        // Exponential growth
        currentMultiplier = Math.pow(2, timeElapsed / 10);

        // Broadcast multiplier to clients (2 decimal precision)
        broadcast(wss, {
          action: "CNT_MULTIPLY",
          multiplier: currentMultiplier.toFixed(2),
          time: timeElapsed,
        });

        // Crash reached
        if (currentMultiplier >= crashPoint) {
          clearInterval(interval);
          isRunning = false;
          await endGame(wss, round._id);
        }
      }, 50);
    }, 11000); // Wait for countdown
  } catch (err) {
    console.error("❌ Error in startGame:", err);
  }
}

// ----------------- End Game -----------------
async function endGame(wss, roundId) {
  const round = await GameRound.findById(roundId);
  if (!round) return;

  round.crashMultiplier = currentMultiplier;
  await round.save();

  broadcast(wss, { action: "ROUND_CRASHED", multiplier: currentMultiplier.toFixed(2) });
  console.log(`💥 Round crashed at ${currentMultiplier.toFixed(2)}x`);

  // Reveal seed every 100 rounds for verification
  const totalRounds = await GameRound.countDocuments();
  if (totalRounds % 100 === 0) {
    const currentSeed = await ProvablyFairSeed.findOne({ revealed: false });
    if (currentSeed) {
      currentSeed.revealed = true;
      currentSeed.revealedAt = new Date();
      await currentSeed.save();

      broadcast(wss, {
        action: "SEED_REVEALED",
        serverSeed: currentSeed.serverSeed,
        serverSeedHash: currentSeed.serverSeedHash,
      });

      console.log(`🔓 Revealed seed: ${currentSeed.serverSeed}`);
    }
  }

  // Start next round after 5s
  setTimeout(() => startGame(wss), 5000);
}

// ----------------- Handle Bets -----------------
async function handleBet(ws, data, wss) {
  try {
    const { walletAddress, amount, currency } = data;
    if (gameState !== "waiting") {
      return ws.send(JSON.stringify({ action: "ERROR", message: "Betting closed." }));
    }

    const user = await User.findOne({ walletAddress });
    if (!user) return ws.send(JSON.stringify({ action: "ERROR", message: "User not found." }));
    if (user.balances[currency] < amount)
      return ws.send(JSON.stringify({ action: "ERROR", message: "Insufficient balance." }));

    let round = await GameRound.findOne().sort({ startTime: -1 });
    if (!round) return ws.send(JSON.stringify({ action: "ERROR", message: "No active round." }));

    user.balances[currency] -= amount;
    await user.save();

    round.bets.push({ walletAddress, amount, currency, cashedOut: false });
    await round.save();

    ws.send(JSON.stringify({ action: "BET_PLACED", walletAddress, amount, currency }));
    broadcast(wss, { action: "PLAYER_BET", walletAddress, amount, currency });
  } catch (err) {
    console.error("❌ Error placing bet:", err);
  }
}

// ----------------- Handle Cashout -----------------
async function handleCashout(ws, data, wss) {
  try {
    if (!isRunning)
      return ws.send(JSON.stringify({ action: "ERROR", message: "Cannot cash out now." }));

    const { walletAddress } = data;
    const round = await GameRound.findOne().sort({ startTime: -1 });
    const bet = round.bets.find(b => b.walletAddress === walletAddress);
    if (!bet) return ws.send(JSON.stringify({ action: "ERROR", message: "No active bet." }));
    if (bet.cashedOut) return ws.send(JSON.stringify({ action: "ERROR", message: "Already cashed out." }));

    const user = await User.findOne({ walletAddress });
    const winnings = Math.floor(bet.amount * currentMultiplier * 100) / 100;
    user.balances[bet.currency] += winnings;
    await user.save();

    bet.cashedOut = true;
    await round.save();

    ws.send(
      JSON.stringify({
        action: "CASHOUT_SUCCESS",
        walletAddress,
        winnings,
        multiplier: currentMultiplier.toFixed(2),
      })
    );

    broadcast(wss, {
      action: "PLAYER_CASHED_OUT",
      walletAddress,
      winnings,
      multiplier: currentMultiplier.toFixed(2),
    });
  } catch (err) {
    console.error("❌ Cashout error:", err);
  }
}

// ----------------- Exports -----------------
module.exports = {
  startGame,
  handleBet,
  handleCashout,
};
