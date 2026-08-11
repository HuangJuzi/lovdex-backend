import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';

const LEGACY_TASKS_DDL = `
CREATE TABLE tasks (
    task_id           TEXT PRIMARY KEY NOT NULL,
    project_path      TEXT NOT NULL REFERENCES projects(project_path) ON DELETE CASCADE ON UPDATE CASCADE,
    title             TEXT NOT NULL,
    description       TEXT,
    status            TEXT NOT NULL DEFAULT 'backlog'
                      CHECK (status IN ('backlog','todo','in_progress','in_review','done')),
    executor_provider TEXT NOT NULL DEFAULT 'claude' CHECK (executor_provider IN ('claude','codex')),
    executor_model    TEXT,
    position          REAL NOT NULL DEFAULT 0,
    session_id        TEXT,
    started_at        DATETIME,
    completed_at      DATETIME,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    ai_summary       TEXT,
    verdict          TEXT CHECK (verdict IS NULL OR verdict IN ('done','only_plan','needs_review','blocked')),
    verdict_reason   TEXT,
    verdict_at       DATETIME
);
`;

test('migrateTasksTable rebuilds: backlog→todo, verdict→sub_status, drops verdict column', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'migrate-tasks-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;

  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY NOT NULL,
      project_path TEXT NOT NULL UNIQUE,
      custom_project_name TEXT DEFAULT NULL,
      isStarred BOOLEAN DEFAULT 0,
      isArchived BOOLEAN DEFAULT 0
    );
  `);
  legacy.exec(LEGACY_TASKS_DDL);
  legacy.prepare(`INSERT INTO projects (project_id, project_path) VALUES (?, ?)`).run('p1', '/tmp/example-repo');
  const ins = legacy.prepare(`INSERT INTO tasks (task_id, project_path, title, status, verdict, verdict_reason) VALUES (?, ?, ?, ?, ?, ?)`);
  ins.run('t1', '/tmp/example-repo', 'backlogged', 'backlog', null, null);
  ins.run('t2', '/tmp/example-repo', 'judged-done', 'in_review', 'done', 'all good');
  ins.run('t3', '/tmp/example-repo', 'judged-blocked', 'in_review', 'blocked', 'broke');
  ins.run('t4', '/tmp/example-repo', 'plain-review', 'in_review', null, null);
  legacy.close();

  await initializeDatabase();

  try {
    const db = getConnection();
    const rows = db.prepare('SELECT task_id, status, sub_status, verdict_reason FROM tasks ORDER BY task_id').all() as {
      task_id: string; status: string; sub_status: string | null; verdict_reason: string | null;
    }[];
    const byId = Object.fromEntries(rows.map((r) => [r.task_id, r]));

    assert.equal(byId['t1'].status, 'todo');            // backlog → todo
    assert.equal(byId['t1'].sub_status, null);
    assert.equal(byId['t2'].status, 'in_review');       // done 判定留评审列
    assert.equal(byId['t2'].sub_status, 'done');
    assert.equal(byId['t2'].verdict_reason, 'all good');
    assert.equal(byId['t3'].status, 'in_progress');     // 非 done 判定移回进行中
    assert.equal(byId['t3'].sub_status, 'blocked');
    assert.equal(byId['t3'].verdict_reason, 'broke');
    assert.equal(byId['t4'].status, 'in_review');       // 无判定留评审列
    assert.equal(byId['t4'].sub_status, null);

    const cols = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    assert.ok(cols.some((c) => c.name === 'sub_status'));
    assert.ok(!cols.some((c) => c.name === 'verdict')); // verdict 列已删
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('migrateTasksTable adds priority/deadline/is_operator/label/remark', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'migrate-tasks-cols-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;

  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY NOT NULL,
      project_path TEXT NOT NULL UNIQUE,
      custom_project_name TEXT DEFAULT NULL,
      isStarred BOOLEAN DEFAULT 0,
      isArchived BOOLEAN DEFAULT 0
    );
  `);
  legacy.exec(LEGACY_TASKS_DDL);
  legacy.prepare(`INSERT INTO projects (project_id, project_path) VALUES (?, ?)`).run('p1', '/tmp/example-repo');
  legacy.prepare(`INSERT INTO tasks (task_id, project_path, title, status) VALUES (?, ?, ?, ?)`).run('t1', '/tmp/example-repo', 'task', 'todo');
  legacy.close();

  await initializeDatabase();

  try {
    const db = getConnection();
    const cols = db.prepare('PRAGMA table_info(tasks)').all().map((c: any) => c.name);
    for (const col of ['priority', 'deadline', 'is_operator', 'label', 'remark']) {
      assert.ok(cols.includes(col), `missing column ${col}`);
    }
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql: string };
    assert.match(row.sql, /CHECK \(priority IN \('P0','P1','P2','P3'\)\)/);
    assert.match(row.sql, /CHECK \(label IN \('bug','feature','optimization','refactor','docs','other'\)\)/);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('fresh install creates tasks table with sub_status and no verdict column', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'migrate-fresh-tasks-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;

  await initializeDatabase();

  try {
    const db = getConnection();
    const cols = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    assert.ok(cols.some((c) => c.name === 'sub_status'));
    assert.ok(!cols.some((c) => c.name === 'verdict'), 'verdict column must not exist on fresh installs');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
