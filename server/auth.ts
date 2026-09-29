import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import nodemailer from 'nodemailer';
import { ensureUserDataFile } from './userData';

export interface AuthUser {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

export function isAdminUser(user: AuthUser): boolean {
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((email) => normalizeEmail(email))
    .filter(Boolean);
  return adminEmails.includes(user.email);
}

interface ResetToken {
  userId: string;
  expiresAt: number;
}

const DATA_DIR = path.join(process.cwd(), 'data');
const USERS_PATH = path.join(DATA_DIR, 'users.json');
const SESSIONS_PATH = path.join(DATA_DIR, 'sessions.json');
const SESSION_COOKIE = 'bn_session';
const resetTokens = new Map<string, ResetToken>();

function ensureDataDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }

// Sessions are kept on disk so restarting the server does not sign everyone out.
// Only a hash of each token is stored.
type Session = { userId: string; expiresAt: number };
const sessions = loadSessions();

function hashToken(token: string) { return crypto.createHash('sha256').update(token).digest('hex'); }

function loadSessions(): Map<string, Session> {
  try {
    const parsed = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8')) as Record<string, Session>;
    return new Map(Object.entries(parsed).filter(([, session]) => session?.expiresAt > Date.now()));
  } catch { return new Map(); }
}

function saveSessions() {
  ensureDataDir();
  fs.writeFileSync(SESSIONS_PATH, JSON.stringify(Object.fromEntries(sessions)), 'utf8');
}

function loadUsers(): AuthUser[] {
  ensureDataDir();
  if (!fs.existsSync(USERS_PATH)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function saveUsers(users: AuthUser[]) {
  ensureDataDir();
  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2), 'utf8');
}

function hashPassword(password: string, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string) {
  const [salt, expected] = stored.split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function normalizeEmail(email: string) { return email.trim().toLowerCase(); }

function validPassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= 8 && password.length <= 200;
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const [key, ...value] = part.trim().split('=');
    return [key, decodeURIComponent(value.join('='))];
  }).filter(([key]) => key));
}

/**
 * Makes sure the first ADMIN_EMAILS address has an account whose password is ADMIN_PASSWORD.
 * users.json is not deployed, so without this anyone could register the admin email on a fresh server.
 */
export function ensureAdminAccount() {
  const email = normalizeEmail((process.env.ADMIN_EMAILS || '').split(',')[0] || '');
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !validPassword(password)) return;
  const users = loadUsers();
  const existing = users.find((user) => user.email === email);
  if (existing && verifyPassword(password, existing.passwordHash)) return;
  if (existing) existing.passwordHash = hashPassword(password);
  else users.push({ id: crypto.randomUUID(), email, passwordHash: hashPassword(password), createdAt: new Date().toISOString() });
  saveUsers(users);
}

export function publicUser(user: AuthUser) {
  return { id: user.id, email: user.email, createdAt: user.createdAt, isAdmin: isAdminUser(user) };
}

export function register(emailInput: unknown, password: unknown) {
  const email = typeof emailInput === 'string' ? normalizeEmail(emailInput) : '';
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Please enter a valid email address.');
  if (!validPassword(password)) throw new Error('Password must be at least 8 characters.');
  const users = loadUsers();
  if (users.some((user) => user.email === email)) throw new Error('An account with this email already exists. Please log in.');
  const user: AuthUser = { id: crypto.randomUUID(), email, passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
  users.push(user);
  saveUsers(users);
  if (!isAdminUser(user)) {
    ensureUserDataFile(user.id);
  }
  return user;
}

export function login(emailInput: unknown, password: unknown) {
  const email = typeof emailInput === 'string' ? normalizeEmail(emailInput) : '';
  const user = loadUsers().find((candidate) => candidate.email === email);
  if (!user || typeof password !== 'string' || !verifyPassword(password, user.passwordHash)) {
    throw new Error('Incorrect email or password.');
  }
  if (!isAdminUser(user)) {
    ensureUserDataFile(user.id);
  }
  return user;
}

export function createSession(userId: string) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(hashToken(token), { userId, expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 7 });
  saveSessions();
  return token;
}

export function getUserFromRequest(request: { headers: { cookie?: string } }) {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  const session = token ? sessions.get(hashToken(token)) : undefined;
  if (!session || session.expiresAt <= Date.now()) {
    if (session && token) {
      sessions.delete(hashToken(token));
      saveSessions();
    }
    return undefined;
  }
  return loadUsers().find((user) => user.id === session.userId);
}

export function sessionCookie(token: string) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800${secure}`;
}

export function clearSessionCookie() { return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`; }

export function logout(request: { headers: { cookie?: string } }) {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  if (token && sessions.delete(hashToken(token))) saveSessions();
}

async function sendResetEmail(email: string, token: string) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, APP_URL } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error('Password reset email is not configured. Set SMTP_HOST, SMTP_USER and SMTP_PASS in the server .env file.');
  }
  const transporter = nodemailer.createTransport({ host: SMTP_HOST, port: Number(SMTP_PORT || 587), secure: SMTP_PORT === '465', auth: { user: SMTP_USER, pass: SMTP_PASS } });
  const resetUrl = `${APP_URL || `http://localhost:${process.env.PORT || 3100}`}?resetToken=${encodeURIComponent(token)}`;
  await transporter.sendMail({ from: process.env.SMTP_FROM || SMTP_USER, to: email, subject: 'Bangla AI Assistant: password reset', text: `Open the link below to reset your password. It is valid for 30 minutes:\n\n${resetUrl}` });
}

export async function requestPasswordReset(emailInput: unknown) {
  const email = typeof emailInput === 'string' ? normalizeEmail(emailInput) : '';
  const user = loadUsers().find((candidate) => candidate.email === email);
  if (!user) return;
  const token = crypto.randomBytes(32).toString('hex');
  resetTokens.set(token, { userId: user.id, expiresAt: Date.now() + 1000 * 60 * 30 });
  await sendResetEmail(user.email, token);
}

export function resetPassword(token: unknown, password: unknown) {
  const entry = typeof token === 'string' ? resetTokens.get(token) : undefined;
  if (!entry || entry.expiresAt <= Date.now()) throw new Error('This reset link is invalid or has expired.');
  if (!validPassword(password)) throw new Error('Password must be at least 8 characters.');
  const users = loadUsers();
  const user = users.find((candidate) => candidate.id === entry.userId);
  if (!user) throw new Error('Account not found.');
  user.passwordHash = hashPassword(password);
  saveUsers(users);
  resetTokens.delete(token as string);
}
