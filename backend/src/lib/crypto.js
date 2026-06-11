/**
 * Шифрование токенов at-rest (AES-256-GCM).
 *
 * Формат хранимого значения:  enc:v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
 *
 * Обратная совместимость:
 *   - decrypt() для значений БЕЗ префикса enc:v1: возвращает их как есть
 *     (старые plaintext-токены продолжают работать).
 *   - encrypt() для уже зашифрованного значения возвращает его без изменений
 *     (нет двойного шифрования — безопасно копировать токены между строками).
 *
 * Ключ: переменная окружения TOKEN_ENC_KEY (любая строка; из неё через SHA-256
 * выводится 32-байтный ключ). Если ключ не задан — модуль работает в passthrough:
 * токены НЕ шифруются, в лог пишется предупреждение. Установите TOKEN_ENC_KEY,
 * чтобы включить шифрование.
 */
const crypto = require('crypto');

const PREFIX = 'enc:v1:';
const raw = process.env.TOKEN_ENC_KEY || '';
const KEY = raw ? crypto.createHash('sha256').update(raw, 'utf8').digest() : null;

if (!KEY) {
  console.warn('[CRYPTO] TOKEN_ENC_KEY не задан — токены хранятся в открытом виде. ' +
               'Установите TOKEN_ENC_KEY в окружении, чтобы включить шифрование.');
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** Шифрует строку. null/undefined и уже зашифрованные значения проходят без изменений. */
function encrypt(plain) {
  if (plain == null) return plain;
  const s = String(plain);
  if (!KEY) return s;            // passthrough без ключа
  if (isEncrypted(s)) return s;  // уже зашифровано
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + iv.toString('base64') + ':' + tag.toString('base64') + ':' + ct.toString('base64');
}

/** Расшифровывает строку. Значения без префикса (legacy plaintext) возвращаются как есть. */
function decrypt(stored) {
  if (stored == null) return stored;
  const s = String(stored);
  if (!isEncrypted(s)) return s;  // legacy plaintext
  if (!KEY) {
    console.error('[CRYPTO] Найдено зашифрованное значение, но TOKEN_ENC_KEY не задан — не могу расшифровать.');
    return null;
  }
  try {
    const [ivB64, tagB64, ctB64] = s.slice(PREFIX.length).split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
    return pt.toString('utf8');
  } catch (e) {
    console.error('[CRYPTO] Ошибка расшифровки:', e.message);
    return null;
  }
}

/** Безопасный превью токена (первые 10 символов расшифрованного значения). */
function preview(stored) {
  const p = decrypt(stored);
  if (!p) return '***';
  return p.slice(0, 10) + '...';
}

module.exports = { encrypt, decrypt, preview, isEncrypted };
