const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes("render.com") ? { rejectUnauthorized: false } : undefined });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static("public"));
app.use(session({
  secret: process.env.SESSION_SECRET || "change-me",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7, httpOnly: true, sameSite: "lax" }
}));

const PORT = process.env.PORT || 3000;
const DAILY_REWARD = 50;
const REFERRAL_REWARD = 200;
const TASK_COUNT = 20;
const RESET_MS = 24 * 60 * 60 * 1000;

app.get("/api/ad-config", (req,res)=>res.json({url: process.env.REWARDED_AD_URL || ""}));

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      referral_code TEXT UNIQUE NOT NULL,
      referred_by INTEGER REFERENCES users(id),
      balance NUMERIC(12,2) NOT NULL DEFAULT 0,
      referral_earnings NUMERIC(12,2) NOT NULL DEFAULT 0,
      bank_name TEXT,
      account_number TEXT,
      account_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS task_cycles (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      cycle_start TIMESTAMPTZ NOT NULL,
      UNIQUE(user_id)
    );
    CREATE TABLE IF NOT EXISTS task_completions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      task_number INTEGER NOT NULL,
      cycle_start TIMESTAMPTZ NOT NULL,
      reward NUMERIC(12,2) NOT NULL DEFAULT 50,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, task_number, cycle_start)
    );
    CREATE TABLE IF NOT EXISTS withdrawals (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      bank_name TEXT,
      account_number TEXT,
      account_name TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ
    );
  `);
}

function code() {
  return "REF" + Math.random().toString(36).slice(2, 9).toUpperCase();
}
function logged(req, res, next) {
  if (!req.session.userId) return res.redirect("/login.html");
  next();
}
function admin(req, res, next) {
  if (!req.session.isAdmin) return res.status(403).send("Admin only");
  next();
}
function cycleStart(d = new Date()) {
  return new Date(Math.floor(d.getTime() / RESET_MS) * RESET_MS);
}
function htmlPage(title, body, user=null) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/style.css"></head><body>
  <header><a class="brand" href="/">DailyEarn<span>NG</span></a><nav>${user ? '<a href="/dashboard.html">Dashboard</a><a href="/logout">Logout</a>' : '<a href="/login.html">Login</a><a class="navbtn" href="/register.html">Join Free</a>'}</nav></header>
  ${body}<footer>DailyEarn NG • Daily rewards platform</footer></body></html>`;
}

app.get("/", (req,res)=>res.sendFile(__dirname+"/public/index.html"));
app.post("/api/register", async (req,res)=>{
  try {
    const {name,email,password,referral}=req.body;
    if (!name || !email || !password) return res.status(400).json({error:"All required fields are needed."});
    const hash=await bcrypt.hash(password,12);
    let refUser=null;
    if(referral) refUser=(await pool.query("SELECT id FROM users WHERE referral_code=$1",[referral.trim().toUpperCase()])).rows[0];
    const r=await pool.query("INSERT INTO users(name,email,password_hash,referral_code,referred_by) VALUES($1,$2,$3,$4,$5) RETURNING id, name, email, referral_code",[name,email.toLowerCase(),hash,code(),refUser?.id||null]);
    req.session.userId=r.rows[0].id;
    res.json({ok:true});
  } catch(e) {
    if(e.code==="23505") return res.status(400).json({error:"That email is already registered."});
    console.error(e); res.status(500).json({error:"Registration failed."});
  }
});
app.post("/api/login", async(req,res)=>{
  const {email,password}=req.body;
  const r=await pool.query("SELECT * FROM users WHERE email=$1",[email?.toLowerCase()]);
  if(!r.rows[0] || !(await bcrypt.compare(password,r.rows[0].password_hash))) return res.status(401).json({error:"Invalid email or password."});
  req.session.userId=r.rows[0].id; res.json({ok:true});
});
app.get("/logout",(req,res)=>req.session.destroy(()=>res.redirect("/")));

async function getUser(id){
  return (await pool.query("SELECT * FROM users WHERE id=$1",[id])).rows[0];
}
async function ensureCycle(userId){
  const now=new Date(), current=cycleStart(now);
  const r=await pool.query("SELECT * FROM task_cycles WHERE user_id=$1",[userId]);
  if(!r.rows[0]) {
    await pool.query("INSERT INTO task_cycles(user_id,cycle_start) VALUES($1,$2)",[userId,current]);
    return current;
  }
  if(new Date(r.rows[0].cycle_start).getTime() !== current.getTime()) {
    await pool.query("UPDATE task_cycles SET cycle_start=$1 WHERE user_id=$2",[current,userId]);
  }
  return current;
}
app.get("/api/me",logged,async(req,res)=>{
  const u=await getUser(req.session.userId); const start=await ensureCycle(u.id);
  const done=(await pool.query("SELECT task_number FROM task_completions WHERE user_id=$1 AND cycle_start=$2 ORDER BY task_number",[u.id,start])).rows.map(x=>x.task_number);
  res.json({id:u.id,name:u.name,email:u.email,balance:Number(u.balance),referralEarnings:Number(u.referral_earnings),referralCode:u.referral_code,bankName:u.bank_name,accountNumber:u.account_number,accountName:u.account_name,done,cycleStart:start,nextReset:new Date(start.getTime()+RESET_MS)});
});
app.post("/api/tasks/:n/complete",logged,async(req,res)=>{
  const n=Number(req.params.n); if(n<1||n>TASK_COUNT) return res.status(400).json({error:"Invalid task."});
  const u=await getUser(req.session.userId); const start=await ensureCycle(u.id);
  try {
    await pool.query("BEGIN");
    const exists=await pool.query("SELECT id FROM task_completions WHERE user_id=$1 AND task_number=$2 AND cycle_start=$3",[u.id,n,start]);
    if(exists.rows[0]) { await pool.query("ROLLBACK"); return res.status(400).json({error:"Task already completed."}); }
    await pool.query("INSERT INTO task_completions(user_id,task_number,cycle_start,reward) VALUES($1,$2,$3,$4)",[u.id,n,start,DAILY_REWARD]);
    await pool.query("UPDATE users SET balance=balance+$1 WHERE id=$2",[DAILY_REWARD,u.id]);
    await pool.query("COMMIT");
    res.json({ok:true,reward:DAILY_REWARD});
  } catch(e){await pool.query("ROLLBACK");console.error(e);res.status(500).json({error:"Could not complete task."});}
});
app.post("/api/profile",logged,async(req,res)=>{
  const {bankName,accountNumber,accountName}=req.body;
  await pool.query("UPDATE users SET bank_name=$1,account_number=$2,account_name=$3 WHERE id=$4",[bankName,accountNumber,accountName,req.session.userId]);
  res.json({ok:true});
});
app.post("/api/withdraw",logged,async(req,res)=>{
  const u=await getUser(req.session.userId); const amount=Number(req.body.amount);
  if(!amount || amount<1000) return res.status(400).json({error:"Minimum withdrawal is ₦1,000."});
  if(amount>Number(u.balance)) return res.status(400).json({error:"Insufficient balance."});
  if(!u.bank_name||!u.account_number||!u.account_name) return res.status(400).json({error:"Add your bank details first."});
  const now=new Date(), nextMonth=new Date(now.getFullYear(),now.getMonth()+1,1);
  // Monthly request window: request is recorded now and processed by admin after ad revenue payout.
  await pool.query("BEGIN");
  await pool.query("UPDATE users SET balance=balance-$1 WHERE id=$2",[amount,u.id]);
  await pool.query("INSERT INTO withdrawals(user_id,amount,bank_name,account_number,account_name) VALUES($1,$2,$3,$4,$5)",[u.id,amount,u.bank_name,u.account_number,u.account_name]);
  await pool.query("COMMIT");
  res.json({ok:true,message:"Withdrawal request submitted for the monthly payout cycle."});
});

app.get("/admin",admin,async(req,res)=>{
  const users=(await pool.query("SELECT id,name,email,balance,referral_code,created_at FROM users ORDER BY id DESC")).rows;
  const w=(await pool.query("SELECT w.*,u.name,u.email FROM withdrawals w JOIN users u ON u.id=w.user_id ORDER BY w.id DESC")).rows;
  res.send(htmlPage("Admin",`<main class="admin"><div class="panel"><h1>Admin Dashboard</h1><p>Manage users and monthly withdrawals.</p><h2>Users</h2><div class="table">${users.map(u=>`<div><b>${u.name}</b><br>${u.email}<br>Balance: ₦${Number(u.balance).toLocaleString()}<br>Ref: ${u.referral_code}</div>`).join("")}</div><h2>Withdrawals</h2><div class="table">${w.map(x=>`<div><b>${x.name}</b> — ₦${Number(x.amount).toLocaleString()}<br>${x.bank_name} • ${x.account_number} • ${x.account_name}<br>Status: <b>${x.status}</b>${x.status==="pending"?`<button onclick="approve(${x.id})">Mark paid</button>`:""}</div>`).join("")}</div></div></main><script>async function approve(id){let r=await fetch("/admin/withdraw/"+id,{method:"POST"});let j=await r.json();alert(j.message||j.error);location.reload()}</script>`));
});
app.post("/admin/withdraw/:id",admin,async(req,res)=>{
  await pool.query("UPDATE withdrawals SET status='paid',processed_at=NOW() WHERE id=$1 AND status='pending'",[req.params.id]);
  res.json({ok:true,message:"Withdrawal marked as paid."});
});
app.get("/admin/login",(req,res)=>res.send(htmlPage("Admin Login",`<main class="auth"><div class="panel"><h1>Admin Login</h1><form method="post" action="/admin/login"><input name="email" placeholder="Admin email" required><input name="password" type="password" placeholder="Password" required><button>Login</button></form></div></main>`)));
app.post("/admin/login",(req,res)=>{
  if(req.body.email===process.env.ADMIN_EMAIL && req.body.password===process.env.ADMIN_PASSWORD){req.session.isAdmin=true;return res.redirect("/admin");}
  res.status(401).send("Invalid admin credentials");
});

init().then(()=>app.listen(PORT,()=>console.log("DailyEarn NG running on "+PORT))).catch(e=>{console.error(e);process.exit(1)});
