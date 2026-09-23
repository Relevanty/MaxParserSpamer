import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadListUsers } from '../src/io.js';
import { loadSettings } from '../src/settings.js';

test('loadListUsers ignores non-list files and only reads .txt lists', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'relevanty-io-'));

  try {
    await mkdir(tempDir, { recursive: true });
    await writeFile(path.join(tempDir, 'chat-a.txt'), 'alice\nbob\n', 'utf8');
    await writeFile(path.join(tempDir, 'chat-b.txt'), 'carol\n', 'utf8');
    await writeFile(path.join(tempDir, 'chat-a.state.json'), '{"offsetId":3}\n', 'utf8');
    await writeFile(path.join(tempDir, 'notes.md'), 'ignore\n', 'utf8');

    const users = await loadListUsers(tempDir);

    assert.deepEqual(
      users.map((user) => ({ fileName: user.fileName, raw: user.raw })),
      [
        { fileName: 'chat-a.txt', raw: 'alice' },
        { fileName: 'chat-a.txt', raw: 'bob' },
        { fileName: 'chat-b.txt', raw: 'carol' },
      ]
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('loadSettings defaults to skipping existing chats unless explicitly enabled', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'relevanty-settings-'));
  const originalCwd = process.cwd();

  try {
    process.chdir(tempDir);
    const settings = await loadSettings();
    assert.equal(settings.allowExistingChats, false);
    assert.equal(settings.ignoreProcessed, false);
  } finally {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});
