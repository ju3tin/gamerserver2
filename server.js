// server.js
// Entry point: sets up Express API, static files, WebSocket server and hooks GameController.

require("dotenv").config();
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const mongoose = require("mongoose");
const path = require("path");

// Import controller functions that contain game logic
const { startGame, handleBet, handleCashout } = require("./controllers/GameController");

// Environment variables
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/bustafair";
const PORT = parseInt(process.env.PORT || "3000", 10);
const WS_PORT = parseInt(process.env.WS_PORT || "8080", 10);

// Create Express app and HTTP server
const app = express();
const httpServer = http.createServer(app);

// Serve static UI files from /public
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Connect to MongoDB
mongoose.connect(MONGODB_URI, {});

// Simple API route to get status (current round + seedHash)
app.get("/api/status", async (req, res) => {
  const GameRound = require("./models/GameRound");
  const lastRound = await GameRound.findOne().sort({ startTime: -1 }).exec();
  res.json({
    currentRoundId: lastRound ? lastRound._id : null,
    seedHash: lastRound ? lastRound.seedHash : null,
    crashMultiplier: lastRound ? lastRound.crashMultiplier : null,
  });
});

// Start HTTP server
httpServer.listen(PORT, () => {
  console.log(`HTTP server listening on http://localhost:${PORT}`);
});

// Create WebSocket server on same HTTP server (same port), or standalone if you prefer
const wss = new WebSocketServer({ server: httpServer });

// Manage connected clients and wire incoming messages to controller
wss.on("connection", (ws) => {
  console.log("Client connected via WebSocket");

  // Send greeting
  ws.send(JSON.stringify({ action: "WELCOME", message: "Connected to provably-fair crash server" }));

  // Handle incoming JSON messages
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      return ws.send(JSON.stringify({ action: "ERROR", message: "Invalid JSON" }));
    }

    // Route message types to controller functions
    if (msg.action === "PLACE_BET") {
      // PLACE_BET payload: { walletAddress, amount, currency }
      handleBet(ws, msg, wss);
    } else if (msg.action === "CASHOUT") {
      // CASHOUT payload: { walletAddress }
      handleCashout(ws, msg, wss);
    } else if (msg.action === "GET_STATUS") {
      // Provide current round status
      const GameRound = require("./models/GameRound");
      GameRound.findOne().sort({ startTime: -1 }).then((r) => {
        ws.send(JSON.stringify({ action: "STATUS", round: r }));
      });
    } else {
      ws.send(JSON.stringify({ action: "ERROR", message: "Unknown action" }));
    }
  });
});

// Start the game loop
startGame(wss);
