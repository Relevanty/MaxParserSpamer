import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildConnectionOptions, resolveEnvPath } from '../src/auth.js';

test('resolveEnvPath uses DOTENV_CONFIG_PATH when provided', () => {
  const original = process.env.DOTENV_CONFIG_PATH;
  process.env.DOTENV_CONFIG_PATH = 'custom.env';
  try {
    assert.equal(resolveEnvPath(), 'C:\\Users\\maxko\\OneDrive\\Desktop\\AllRelevanty\\Relevanty\\Relevanty\\custom.env');
  } finally {
    if (original === undefined) delete process.env.DOTENV_CONFIG_PATH;
    else process.env.DOTENV_CONFIG_PATH = original;
  }
});

test('resolveEnvPath uses profile-specific env file when present', () => {
  const originalProfile = process.env.PROFILE;
  const originalDotenv = process.env.DOTENV_CONFIG_PATH;
  const profileFile = path.resolve('.env.acc1');
  fs.writeFileSync(profileFile, 'TEST=1\n');
  process.env.PROFILE = 'acc1';
  delete process.env.DOTENV_CONFIG_PATH;

  try {
    assert.equal(resolveEnvPath(), profileFile);
  } finally {
    fs.unlinkSync(profileFile);
    if (originalProfile === undefined) delete process.env.PROFILE;
    else process.env.PROFILE = originalProfile;
    if (originalDotenv === undefined) delete process.env.DOTENV_CONFIG_PATH;
    else process.env.DOTENV_CONFIG_PATH = originalDotenv;
  }
});

test('buildConnectionOptions parses proxy and transport settings', () => {
  const original = {
    SOCKS_PROXY: process.env.SOCKS_PROXY,
    TELEGRAM_TRANSPORT: process.env.TELEGRAM_TRANSPORT,
    TELEGRAM_USE_WSS: process.env.TELEGRAM_USE_WSS,
    TELEGRAM_CONNECTION_RETRIES: process.env.TELEGRAM_CONNECTION_RETRIES,
    TELEGRAM_RETRY_DELAY_MS: process.env.TELEGRAM_RETRY_DELAY_MS,
  };

  process.env.SOCKS_PROXY = '127.0.0.1:1080';
  process.env.TELEGRAM_TRANSPORT = 'obfuscated';
  process.env.TELEGRAM_USE_WSS = 'true';
  process.env.TELEGRAM_CONNECTION_RETRIES = '7';
  process.env.TELEGRAM_RETRY_DELAY_MS = '1500';

  try {
    const options = buildConnectionOptions();
    assert.equal(options.proxy?.ip, '127.0.0.1');
    assert.equal(options.proxy?.port, 1080);
    assert.equal(options.proxy?.socksType, 5);
    assert.equal(options.connectionRetries, 7);
    assert.equal(options.retryDelay, 1500);
    assert.equal(options.transportName, 'obfuscated');
    assert.equal(options.useWss, true);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
