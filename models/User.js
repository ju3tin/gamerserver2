// models/User.js
// A minimal user model with balances and walletAddress.
// Adapt to your auth/wallet model as needed.

const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  walletAddress: { type: String, required: true, unique: true }, // unique id
  balances: {
    SOL: { type: Number, default: 1000 },
    CHIPPY: { type: Number, default: 1000 },
    DEMO: { type: Number, default: 1000 }
  },    // map currency->amount
  clientSeed: { type: String, default: "player_client_seed" },   // optional per-player seed
  createdAt: { type: Date, default: () => new Date() },
});

module.exports = mongoose.model("User", UserSchema);
