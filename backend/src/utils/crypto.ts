import { config } from '../config';

// XOR-based reversible encryption for storing Spotify tokens.
// Keeps tokens unreadable in the DB without being overkill for MVP.
// Replace with AES-256-GCM for production if needed.

function getKey(): string {
  return config.JWT_SECRET.slice(0, 32).padEnd(32, '0');
}

export function encrypt(text: string): string {
  const key = getKey();
  let result = '';
  for (let i = 0; i < text.length; i++) {
    result += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return Buffer.from(result, 'binary').toString('base64');
}

export function decrypt(encoded: string): string {
  const key = getKey();
  const text = Buffer.from(encoded, 'base64').toString('binary');
  let result = '';
  for (let i = 0; i < text.length; i++) {
    result += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return result;
}
