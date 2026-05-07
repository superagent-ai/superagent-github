import Database, { type Database as DatabaseType, type Statement } from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { env } from "./env.js";
import { logger } from "./logger.js";

const dbDir = path.dirname(env.dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db: DatabaseType = new Database(env.dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS installations (
    id              INTEGER PRIMARY KEY,
    account_login   TEXT    NOT NULL,
    account_type    TEXT    NOT NULL DEFAULT 'User',
    repo_selection  TEXT    NOT NULL DEFAULT 'selected',
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    removed_at      TEXT
  );

  CREATE TABLE IF NOT EXISTS installation_repos (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    installation_id INTEGER NOT NULL REFERENCES installations(id),
    repo_name       TEXT    NOT NULL,
    repo_full_name  TEXT    NOT NULL,
    private         INTEGER NOT NULL DEFAULT 0,
    added_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(installation_id, repo_full_name)
  );

  CREATE TABLE IF NOT EXISTS contributor_scans (
    login       TEXT PRIMARY KEY,
    result_json TEXT NOT NULL,
    scanned_at  TEXT NOT NULL
  );
`);

logger.info({ path: env.dbPath }, "Database initialized");

export const queries: Record<string, Statement> = {
  upsertInstallation: db.prepare(`
    INSERT INTO installations (id, account_login, account_type, repo_selection)
    VALUES (@id, @accountLogin, @accountType, @repoSelection)
    ON CONFLICT(id) DO UPDATE SET
      account_login  = @accountLogin,
      account_type   = @accountType,
      repo_selection = @repoSelection,
      active         = 1,
      removed_at     = NULL
  `),

  markInstallationRemoved: db.prepare(`
    UPDATE installations SET active = 0, removed_at = datetime('now') WHERE id = @id
  `),

  upsertRepo: db.prepare(`
    INSERT INTO installation_repos (installation_id, repo_name, repo_full_name, private)
    VALUES (@installationId, @repoName, @repoFullName, @private)
    ON CONFLICT(installation_id, repo_full_name) DO UPDATE SET
      repo_name = @repoName,
      private   = @private
  `),

  removeReposForInstallation: db.prepare(`
    DELETE FROM installation_repos WHERE installation_id = @installationId
  `),

  getActiveInstallations: db.prepare(`
    SELECT i.*, GROUP_CONCAT(r.repo_full_name) as repos
    FROM installations i
    LEFT JOIN installation_repos r ON r.installation_id = i.id
    WHERE i.active = 1
    GROUP BY i.id
    ORDER BY i.created_at DESC
  `),

  getInstallation: db.prepare(`
    SELECT i.*, GROUP_CONCAT(r.repo_full_name) as repos
    FROM installations i
    LEFT JOIN installation_repos r ON r.installation_id = i.id
    WHERE i.id = @id
    GROUP BY i.id
  `),

  getAllInstallations: db.prepare(`
    SELECT i.*, GROUP_CONCAT(r.repo_full_name) as repos
    FROM installations i
    LEFT JOIN installation_repos r ON r.installation_id = i.id
    GROUP BY i.id
    ORDER BY i.created_at DESC
  `),

  getStats: db.prepare(`
    SELECT
      COUNT(*)                          as total,
      SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN active = 0 THEN 1 ELSE 0 END) as removed
    FROM installations
  `),

  getContributorScan: db.prepare(`
    SELECT result_json as resultJson, scanned_at as scannedAt
    FROM contributor_scans
    WHERE login = @login
  `),

  upsertContributorScan: db.prepare(`
    INSERT INTO contributor_scans (login, result_json, scanned_at)
    VALUES (@login, @resultJson, @scannedAt)
    ON CONFLICT(login) DO UPDATE SET
      result_json = @resultJson,
      scanned_at  = @scannedAt
  `),
};

export function saveInstallation(
  installation: { id: number; account: { login: string; type: string }; repository_selection: string },
  repositories: { name: string; full_name: string; private: boolean }[],
) {
  const tx = db.transaction(() => {
    queries.upsertInstallation.run({
      id: installation.id,
      accountLogin: installation.account.login,
      accountType: installation.account.type,
      repoSelection: installation.repository_selection,
    });

    for (const repo of repositories) {
      queries.upsertRepo.run({
        installationId: installation.id,
        repoName: repo.name,
        repoFullName: repo.full_name,
        private: repo.private ? 1 : 0,
      });
    }
  });
  tx();
}

export function removeInstallation(installationId: number) {
  const tx = db.transaction(() => {
    queries.markInstallationRemoved.run({ id: installationId });
    queries.removeReposForInstallation.run({ installationId });
  });
  tx();
}
