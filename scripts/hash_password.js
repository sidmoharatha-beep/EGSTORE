// Generates a password hash in the same format the Worker expects: "saltHex:hashHex"
// Usage: node scripts/hash_password.js <password>
const crypto = require("crypto");

const password = process.argv[2];
if (!password) {
  console.error("Usage: node scripts/hash_password.js <password>");
  process.exit(1);
}

const salt = crypto.randomBytes(16);
const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, "sha256");
console.log(salt.toString("hex") + ":" + hash.toString("hex"));
