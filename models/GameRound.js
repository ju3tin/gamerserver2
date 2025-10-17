// models/GameRound.js
// Stores each round's metadata: start time, bets, crash multiplier, and verification hashes.

const mongoose = require("mongoose");

const BetSchema = new mongoose.Schema({
  walletAddress: String,
  amount: Number,
  currency: String,
  cashedOut: { type: Boolean, default: false },
  cashedOutAt: { type: Number, default: null }, // multiplier at cashout
  winnings: { type: Number, default: 0 },
});

const GameRoundSchema = new mongoose.Schema({
  startTime: { type: Date, default: () => new Date() }, // when round was created
  crashMultiplier: { type: Number, default: 0 },        // saved crash multiplier (final)
  bets: { type: [BetSchema], default: [] },             // bets array
  seedHash: String,                                     // public hash of server seed used
  roundHash: String,                                    // deterministic round hash (server+client+nonce)
  createdAt: { type: Date, default: () => new Date() },
});

module.exports = mongoose.model("GameRound", GameRoundSchema);
