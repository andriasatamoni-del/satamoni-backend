const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db/pool");

async function seedUser({ branchId = null, name, email, password = "test12345", role, pin = null }) {
  const passwordHash = await bcrypt.hash(password, 10);
  const pinHash = pin ? await bcrypt.hash(pin, 10) : null;
  const result = await pool.query(
    `INSERT INTO users (branch_id, name, email, password_hash, role, pin_hash)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [branchId, name, email, passwordHash, role, pinHash]
  );
  return result.rows[0].id;
}

async function login(email, password = "test12345") {
  const res = await request(app).post("/api/auth/login").send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

function authed(token) {
  return { Authorization: `Bearer ${token}` };
}

module.exports = { app, request, pool, seedUser, login, authed };
