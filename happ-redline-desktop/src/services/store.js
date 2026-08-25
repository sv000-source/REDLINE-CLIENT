'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EMPTY_STATE = Object.freeze({ version: 1, subscriptions: [] });

class SecureStore {
  constructor({ directory, safeStorage }) {
    this.directory = directory;
    this.safeStorage = safeStorage;
    this.filePath = path.join(directory, 'subscriptions.secure.json');
    fs.mkdirSync(directory, { recursive: true });
  }

  encryptionAvailable() {
    try { return Boolean(this.safeStorage?.isEncryptionAvailable()); }
    catch (_) { return false; }
  }

  read() {
    if (!fs.existsSync(this.filePath)) return structuredClone(EMPTY_STATE);
    try {
      const wrapper = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      let plain;
      if (wrapper.format === 'safeStorage-v1') {
        if (!this.encryptionAvailable()) throw new Error('Системное хранилище ключей сейчас недоступно');
        plain = this.safeStorage.decryptString(Buffer.from(wrapper.data, 'base64'));
      } else if (wrapper.format === 'json-fallback-v1') {
        plain = Buffer.from(wrapper.data, 'base64').toString('utf8');
      } else {
        throw new Error('Неизвестный формат локального хранилища');
      }
      const value = JSON.parse(plain);
      if (!value || value.version !== 1 || !Array.isArray(value.subscriptions)) throw new Error('Повреждена структура хранилища');
      return value;
    } catch (error) {
      const backup = `${this.filePath}.broken-${Date.now()}`;
      try { fs.copyFileSync(this.filePath, backup); } catch (_) { /* best effort */ }
      throw new Error(`Не удалось открыть локальные подписки: ${error.message}`);
    }
  }

  write(value) {
    const plain = JSON.stringify(value);
    const encrypted = this.encryptionAvailable();
    const wrapper = encrypted
      ? { format: 'safeStorage-v1', data: this.safeStorage.encryptString(plain).toString('base64') }
      : { format: 'json-fallback-v1', data: Buffer.from(plain, 'utf8').toString('base64') };
    const temp = `${this.filePath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(wrapper), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, this.filePath);
    try { fs.chmodSync(this.filePath, 0o600); } catch (_) { /* Windows ACLs are managed by the OS. */ }
    return { encrypted };
  }
}

module.exports = { SecureStore, EMPTY_STATE };
