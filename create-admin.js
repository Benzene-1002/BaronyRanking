// create-admin.js
const db = require("./db");
const bcrypt = require("bcryptjs");

const [, , username, password] = process.argv;
if (!username || !password) {
  console.error("Usage: node create-admin.js <username> <password>");
  process.exit(1);
}

(async () => {
  const hash = await bcrypt.hash(password, 12);
  try {
    db.prepare(`INSERT INTO admins(username, password_hash) VALUES(?, ?)`).run(
      username,
      hash
    );
    console.log(`OK: admin '${username}' created`);
  } catch (e) {
    console.error("ERR:", e.message);
  }
})();
