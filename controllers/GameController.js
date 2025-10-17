// controllers/GameController.js

// ----------------- Imports -----------------
const crypto = require("crypto");
const GameRound = require("../models/GameRound");
const User = require("../models/User");
const ProvablyFairSeed = require("../models/ProvablyFairSeed");

// ----------------- Game State -----------------
let currentMultiplier = 1.0;    // Live multiplier
let gameState = "waiting";      // "waiting" | "running" | "ended"
let isRunning = false;          // Prevents multiple intervals
let timeElapsed = 0;            // Tracks elapsed time for exponential curve

// ----------------- Utility: Hash helpers -----------------
function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

// Bustabit-like deterministic multiplier algorithm
function getBustMultiplier(hash) {
  const h = parseInt(hash.slice(0, 13), 16);
  const e = 2 ** 52;
  if (h % 33 === 0) return 1.0; // 1/33 chance of instant crash
  const result = (100 * (e - h)) / (e - 1);
  return Math.floor(result) / 100;
}

// Combine serverSeed, clientSeed, and round index (nonce)
function getRoundHash(serverSeed, clientSeed, nonce) {
  return sha256(`${serverSeed}:${clientSeed}:${nonce}`);
}

// Generate random 32-byte server seed
function generateServerSeed() {
  return crypto.randomBytes(32).toString("hex");
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

// ----------------- Game Core -----------------
async function startGame(wss) {
  try {
    // Set initial state for new round
    gameState = "waiting";
    isRunning = false;
    currentMultiplier = 1.0;
    timeElapsed = 0;

    // Ensure we have a current active seed
    const seedDoc = await ensureSeed();

    // Create a new round in DB
    const round = new GameRound({
      startTime: new Date(),
      crashMultiplier: 0,
      bets: [],
      seedHash: seedDoc.serverSeedHash,
    });
    await round.save();

    console.log(`🎮 New round created. Seed hash: ${seedDoc.serverSeedHash}`);

    broadcast(wss, { action: "GAME_WAITING", message: "Place your bets!" });

    // ----------------- Countdown Phase -----------------
    let countdown = 10;
    const countdownInterval = setInterval(() => {
      broadcast(wss, { action: "COUNTDOWN", time: countdown });
      countdown--;
      if (countdown < 0) clearInterval(countdownInterval);
    }, 1000);

    // After countdown, start the live round
    setTimeout(async () => {
      gameState = "running";
      isRunning = true;

      // Calculate provably fair crash point
      const nonce = await GameRound.countDocuments();
      const clientSeed = "global_client_seed";
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

      console.log(`🚀 Round started, will crash at ${crashPoint}x`);

      // ----------------- Multiplier Simulation -----------------
      timeElapsed = 0;
      const interval = setInterval(async () => {
        timeElapsed += 0.05; // Every 50ms
        currentMultiplier = parseFloat(Math.pow(2, timeElapsed / 10).toFixed(2));

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
    }, 11000); // Wait 11 seconds for countdown

  } catch (err) {
    console.error("❌ Error starting game:", err);
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

  // Start next round after 5 seconds
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

    // Deduct bet from user balance
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
