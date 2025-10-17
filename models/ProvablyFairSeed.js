// models/ProvablyFairSeed.js
// Mongoose model that stores server seeds (secret) and their public hash.
// One seed is used for a period of rounds; when revealed, clients can verify rounds.

const mongoose = require("mongoose");

const ProvablyFairSeedSchema = new mongoose.Schema({
  serverSeed: { type: String, required: true },     // secret (revealed later)
  serverSeedHash: { type: String, required: true }, // SHA256(serverSeed) shown before reveal
  revealed: { type: Boolean, default: false },      // has the seed been revealed?
  revealedAt: Date,                                 // when seed was revealed
  createdAt: { type: Date, default: () => new Date() },
});

module.exports = mongoose.model("ProvablyFairSeed", ProvablyFairSeedSchema);
