// tools/verifyRound.js
// Usage: node tools/verifyRound.js <serverSeed> <clientSeed> <nonce> <expectedBust>
const crypto = require("crypto");

const [,, serverSeed, clientSeed, nonceArg, expectedArg] = process.argv;
if (!serverSeed || !clientSeed || !nonceArg) {
  console.log("Usage: node tools/verifyRound.js <serverSeed> <clientSeed> <nonce> [expectedBust]");
  process.exit(1);
}
const nonce = nonceArg;
const expected = expectedArg ? parseFloat(expectedArg) : null;

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function getBustMultiplier(hash) {
  const h = parseInt(hash.slice(0, 13), 16);
  const e = 2 ** 52;
  if (h % 33 === 0) return 1.0;
  const result = (100 * (e - h)) / (e - 1);
  return Math.floor(result) / 100;
}

const roundHash = sha256(`${serverSeed}:${clientSeed}:${nonce}`);
const bust = getBustMultiplier(roundHash);

console.log("roundHash:", roundHash);
console.log("computed bust:", bust + "x");
if (expected !== null) console.log("expected bust:", expected + "x", "match:", bust === expected);
