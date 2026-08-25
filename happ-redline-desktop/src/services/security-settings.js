'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class SecuritySettings {
  constructor({ directory, safeStorage }) {
    this.safeStorage = safeStorage;
    this.filePath = path.join(directory, 'app-security.json');
    this.data = this.load();
    this.unlocked = !this.data.password;
    this.failedAttempts = 0;
    this.lockUntil = 0;
  }

  encryptionAvailable() { try { return Boolean(this.safeStorage?.isEncryptionAvailable()); } catch (_) { return false; } }

  load() {
    if (!fs.existsSync(this.filePath)) return { version: 1, password: null };
    try {
      const wrapper = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const plain = wrapper.format === 'safeStorage-v1'
        ? this.safeStorage.decryptString(Buffer.from(wrapper.data, 'base64'))
        : Buffer.from(wrapper.data, 'base64').toString('utf8');
      const parsed = JSON.parse(plain);
      return parsed?.version === 1 ? parsed : { version: 1, password: null };
    } catch (_) { return { version: 1, password: null }; }
  }

  save() {
    const plain = JSON.stringify(this.data);
    const wrapper = this.encryptionAvailable()
      ? { format: 'safeStorage-v1', data: this.safeStorage.encryptString(plain).toString('base64') }
      : { format: 'hash-fallback-v1', data: Buffer.from(plain).toString('base64') };
    const temp = `${this.filePath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(wrapper), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, this.filePath);
  }

  derive(password, salt) {
    return crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  }

  status() {
    return {
      required: Boolean(this.data.password),
      unlocked: this.unlocked,
      encrypted: this.encryptionAvailable(),
      lockSeconds: Math.max(0, Math.ceil((this.lockUntil - Date.now()) / 1000)),
      agreementAccepted: this.data.agreement?.version === '1.0',
      agreementVersion: this.data.agreement?.version || '',
      onboardingComplete: Boolean(this.data.onboarding?.complete)
    };
  }

  acceptAgreement() {
    this.data.agreement = { version: '1.0', acceptedAt: new Date().toISOString() };
    this.save();
    return this.status();
  }

  completeOnboarding() {
    this.data.onboarding = { complete: true, completedAt: new Date().toISOString() };
    this.save();
    return this.status();
  }

  resetOnboarding() {
    this.data.onboarding = { complete: false, resetAt: new Date().toISOString() };
    this.save();
    return this.status();
  }

  setPassword(password) {
    const value = String(password || '');
    if (value.length < 4) throw new Error('Пароль должен содержать минимум 4 символа');
    if (value.length > 256) throw new Error('Пароль слишком длинный');
    const salt = crypto.randomBytes(16).toString('base64');
    const hash = this.derive(value, salt).toString('base64');
    this.data.password = { algorithm: 'scrypt-16384', salt, hash, createdAt: new Date().toISOString() };
    this.unlocked = true;
    this.failedAttempts = 0;
    this.save();
    return this.status();
  }

  removePassword() {
    this.data.password = null;
    this.unlocked = true;
    this.failedAttempts = 0;
    this.save();
    return this.status();
  }

  verify(password) {
    if (!this.data.password) { this.unlocked = true; return this.status(); }
    if (Date.now() < this.lockUntil) throw new Error(`Слишком много попыток. Подождите ${Math.ceil((this.lockUntil - Date.now()) / 1000)} сек.`);
    const actual = this.derive(String(password || ''), this.data.password.salt);
    const expected = Buffer.from(this.data.password.hash, 'base64');
    const valid = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    if (!valid) {
      this.failedAttempts += 1;
      if (this.failedAttempts >= 5) { this.lockUntil = Date.now() + 30_000; this.failedAttempts = 0; }
      throw new Error('Неверный пароль');
    }
    this.unlocked = true;
    this.failedAttempts = 0;
    return this.status();
  }
}

module.exports = { SecuritySettings };
